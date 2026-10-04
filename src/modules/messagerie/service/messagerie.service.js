'use strict';

const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  MessageThread, Message, Tenant, Document, Incident, RentSchedule, WorkOrder,
} = require('../../../models/index.js');
const { chargerPourProprietaire, chargerPourLocataire, verifierReference } = require('../../../utils/acces.js');
const { ForbiddenError } = require('../../../errors/AppError.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const documents = require('../../document/service/document.service.js');
const droits = require('../../abonnement/service/droits.service.js');
const { notifier, destinataireLocataire, destinatairesProprietaire } = require('../../notification/service/notification.service.js');

/**
 * Messagerie intégrée propriétaire ↔ locataire (§ 54.1).
 *
 * - UN fil par couple (propriétaire, locataire) — contrainte unique
 *   message_threads_uq — créé à la demande, visible uniquement des membres de
 *   l'espace propriétaire et du locataire concerné (§ 54.1, § 56.2 « message
 *   visible uniquement des deux parties »). Pas de groupes ni d'appels en V1.
 * - Messages texte et photo ; état « envoyé » / « lu » (`read_at`).
 * - Rattachement facultatif à un incident, une échéance ou un travail, qui
 *   doit appartenir au même propriétaire (§ 32) et, pour un message du
 *   locataire, le concerner (§ 28).
 * - Notification push à chaque nouveau message ; JAMAIS de WhatsApp : les
 *   conversations libres sur WhatsApp sont hors V1, la messagerie interne
 *   reste le canal de discussion (§ 54.3).
 *
 * Pas de ligne d'audit par message : l'historique des messages, conservé et
 * jamais modifiable ni supprimable par l'API, EST la trace (§ 54.1 « historique
 * conservé et inclus dans le journal du dossier locataire ») ; le dupliquer
 * dans audit_logs doublerait le volume sans rien apprendre de plus. Les photos
 * passent par documents.creerDocument, qui journalise l'ajout du fichier.
 */

const LONGUEUR_APERCU = 140;

const ROLE_AUTRE = Object.freeze({ proprietaire: 'locataire', locataire: 'proprietaire' });

const RATTACHEMENTS = Object.freeze({
  incident: { Modele: Incident, libelle: 'Incident' },
  rent_schedule: { Modele: RentSchedule, libelle: 'Échéance' },
  work_order: { Modele: WorkOrder, libelle: 'Travaux' },
});

const INCLUDE_DOCUMENT = [{ model: Document, as: 'document', required: false }];

function apercu(texte) {
  if (!texte) return null;
  return texte.length > LONGUEUR_APERCU ? `${texte.slice(0, LONGUEUR_APERCU - 1)}…` : texte;
}

/** Représentation d'API d'un message (état envoyé / lu, § 54.1). */
function messageVersApi(message) {
  return {
    id: message.id,
    thread_id: message.thread_id,
    sender_role: message.sender_role,
    sender_user_id: message.sender_user_id,
    body: message.body,
    document: message.document ? documents.versApi(message.document) : null,
    related_type: message.related_type,
    related_id: message.related_id,
    status: message.read_at ? 'lu' : 'envoye',
    read_at: message.read_at,
    created_at: message.created_at,
  };
}

/** Ligne SQL de liste de fils → représentation d'API. */
function filVersApi(ligne, interlocuteur) {
  return {
    id: ligne.id,
    ...interlocuteur,
    last_message_at: ligne.last_message_at,
    unread_count: Number(ligne.non_lus),
    last_message: ligne.dernier_id ? {
      id: ligne.dernier_id,
      sender_role: ligne.dernier_sender_role,
      preview: apercu(ligne.dernier_body),
      has_photo: Boolean(ligne.dernier_document_id),
      status: ligne.dernier_read_at ? 'lu' : 'envoye',
      created_at: ligne.dernier_created_at,
    } : null,
  };
}

/**
 * Dernier message et non-lus de chaque fil, en UNE requête (jamais une requête
 * par fil) : LATERAL sur messages_thread_idx pour le dernier message, sous-
 * requête sur l'index partiel messages_non_lus_idx pour le compteur.
 * `:roleAutre` = auteur des messages non lus pour l'appelant.
 */
const SELECT_FILS = `
  th.id, th.owner_id, th.tenant_id, th.last_message_at,
  dm.id AS dernier_id, dm.sender_role AS dernier_sender_role, dm.body AS dernier_body,
  dm.document_id AS dernier_document_id, dm.read_at AS dernier_read_at, dm.created_at AS dernier_created_at,
  (SELECT count(*) FROM messages nl
    WHERE nl.thread_id = th.id AND nl.sender_role = :roleAutre AND nl.read_at IS NULL) AS non_lus`;

const LATERAL_DERNIER = `
  LEFT JOIN LATERAL (
    SELECT m.id, m.sender_role, m.body, m.document_id, m.read_at, m.created_at
    FROM messages m WHERE m.thread_id = th.id
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1
  ) dm ON true`;

/**
 * Fil du couple (propriétaire, locataire), créé s'il n'existe pas encore,
 * verrouillé pour la transaction. `ON CONFLICT DO NOTHING` : deux premiers
 * messages simultanés ne créent jamais deux fils (contrainte unique) et
 * aucun des deux n'échoue.
 */
async function filDuCouple(ownerId, tenantId, t) {
  await sequelize.query(
    `INSERT INTO message_threads (owner_id, tenant_id) VALUES (:ownerId, :tenantId)
     ON CONFLICT (owner_id, tenant_id) DO NOTHING`,
    { replacements: { ownerId, tenantId }, transaction: t }
  );
  return MessageThread.findOne({ where: { owner_id: ownerId, tenant_id: tenantId }, lock: t.LOCK.UPDATE, transaction: t });
}

/**
 * Vérifie la ressource rattachée à un message.
 *   - inexistante → 422 ; d'un autre propriétaire → 403 (§ 32) ;
 *   - la ressource doit concerner le locataire du fil (`tenantId`) —
 *     incident ou échéance à son nom, et, pour un message du locataire,
 *     travail lié à l'un de ses incidents ou à l'appartement qu'il occupe
 *     (§ 28 : un locataire ne voit jamais les informations des autres
 *     locataires ; § 54.1 : le message est lié AU dossier de ce locataire)
 *     → 403 sinon. Le propriétaire peut rattacher un travail des parties
 *     communes (sans locataire) au fil d'un locataire.
 */
async function verifierRattachement({ related_type: type, related_id: id }, ownerId, tenantId = null, { parLocataire = true } = {}) {
  if (!type) return;
  const { Modele, libelle } = RATTACHEMENTS[type];
  const ressource = await verifierReference(Modele, id, ownerId, libelle);
  if (!tenantId) return;
  if (type === 'work_order' && !parLocataire) return;

  let concerne;
  if (type === 'work_order') {
    const [ligne] = await sequelize.query(
      `SELECT EXISTS (
         SELECT 1 FROM work_orders wo
         LEFT JOIN incidents i ON i.id = wo.incident_id
         WHERE wo.id = :id
           AND (i.tenant_id = :tenantId
                OR EXISTS (SELECT 1 FROM leases l
                           WHERE l.apartment_id = wo.apartment_id AND l.status = 'actif' AND l.tenant_id = :tenantId))
       ) AS concerne`,
      { replacements: { id, tenantId }, type: QueryTypes.SELECT }
    );
    concerne = ligne.concerne;
  } else {
    concerne = ressource.tenant_id === tenantId;
  }
  if (!concerne) {
    throw new ForbiddenError('Cette ressource ne vous concerne pas : elle ne peut pas être rattachée au message.', 'RATTACHEMENT_REFUSE');
  }
}

/**
 * Enregistre un message (et sa photo), met à jour le fil et notifie l'autre
 * partie — tout dans une transaction : un message annulé ne notifie personne.
 */
async function enregistrer({ ownerId, tenant, auteur, role, donnees, fichier = null, threadId = null }) {
  const executer = fichier ? transactionAvecFichiers : (fn) => sequelize.transaction(fn);
  return executer(async (t) => {
    const thread = threadId
      ? await MessageThread.findByPk(threadId, { lock: t.LOCK.UPDATE, transaction: t })
      : await filDuCouple(ownerId, tenant.id, t);

    // L'identifiant du message est connu AVANT son insertion : la photo
    // (ligne `documents`) le référence, et le message référence la photo.
    const messageId = crypto.randomUUID();
    let document = null;
    if (fichier) {
      document = await documents.creerDocument({
        ownerId,
        tenantId: tenant.id,
        entityType: 'message',
        entityId: messageId,
        category: 'photo',
        fichier,
        // Une photo de conversation est vue des deux parties, par nature.
        visibleToTenant: true,
        uploadedBy: auteur.id,
      }, t);
    }

    const message = await Message.create({
      id: messageId,
      thread_id: thread.id,
      sender_user_id: auteur.id,
      sender_role: role,
      body: donnees.body || null,
      document_id: document?.id || null,
      related_type: donnees.related_type || null,
      related_id: donnees.related_id || null,
    }, { transaction: t });
    await thread.update({ last_message_at: message.created_at }, { transaction: t });

    const versLocataire = role === 'proprietaire';
    await notifier(t, {
      destinataires: versLocataire ? [destinataireLocataire(tenant)] : await destinatairesProprietaire(ownerId, t),
      ownerId,
      type: 'nouveau_message',
      titre: versLocataire ? 'Nouveau message de votre propriétaire' : `Nouveau message de ${tenant.first_name} ${tenant.last_name}`,
      corps: apercu(donnees.body) || 'Photo',
      donnees: { thread_id: thread.id, message_id: message.id },
    });

    message.document = document;
    return messageVersApi(message);
  });
}

async function listerMessages(threadId, { limit, offset }) {
  const { rows, count } = await Message.findAndCountAll({
    where: { thread_id: threadId },
    include: INCLUDE_DOCUMENT,
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });
  return { rows: rows.map(messageVersApi), count };
}

/** Marque « lus » les messages reçus (écrits par l'autre partie) d'un fil. */
async function marquerLus(threadId, roleLecteur) {
  const [nombre] = await Message.update(
    { read_at: new Date() },
    { where: { thread_id: threadId, sender_role: ROLE_AUTRE[roleLecteur], read_at: { [Op.is]: null } } }
  );
  return { marques: nombre };
}

// ── Espace propriétaire ───────────────────────────────────────────────────

/** Fils de l'espace propriétaire, les plus récemment actifs d'abord. */
async function listerFils(ownerId, { limit, offset }) {
  // Un fil n'existe côté propriétaire qu'à partir de son premier message (le
  // locataire peut avoir ouvert un fil vide en consultant sa messagerie).
  const [lignes, total] = await Promise.all([
    sequelize.query(
      `SELECT ${SELECT_FILS}, t.first_name, t.last_name
       FROM message_threads th
       JOIN tenants t ON t.id = th.tenant_id
       ${LATERAL_DERNIER}
       WHERE th.owner_id = :ownerId AND th.last_message_at IS NOT NULL
       ORDER BY th.last_message_at DESC, th.id
       LIMIT :limit OFFSET :offset`,
      { replacements: { ownerId, roleAutre: 'locataire', limit, offset }, type: QueryTypes.SELECT }
    ),
    MessageThread.count({ where: { owner_id: ownerId, last_message_at: { [Op.ne]: null } } }),
  ]);
  return {
    rows: lignes.map((l) => filVersApi(l, { tenant: { id: l.tenant_id, first_name: l.first_name, last_name: l.last_name } })),
    count: total,
  };
}

async function messagesFil(threadId, ownerId, pagination) {
  const thread = await chargerPourProprietaire(MessageThread, threadId, ownerId, {}, 'Fil de discussion');
  return listerMessages(thread.id, pagination);
}

/** Message du propriétaire à l'un de SES locataires (fil créé au besoin). */
async function envoyerProprietaire(ownerId, user, tenantId, donnees, fichier = null) {
  const tenant = await chargerPourProprietaire(
    Tenant, tenantId, ownerId, { attributes: ['id', 'owner_id', 'user_id', 'first_name', 'last_name'] }, 'Locataire'
  );
  await verifierRattachement(donnees, ownerId, tenant.id, { parLocataire: false });
  return enregistrer({ ownerId, tenant, auteur: user, role: 'proprietaire', donnees, fichier });
}

async function marquerLuProprietaire(threadId, ownerId) {
  const thread = await chargerPourProprietaire(MessageThread, threadId, ownerId, { attributes: ['id', 'owner_id'] }, 'Fil de discussion');
  return marquerLus(thread.id, 'proprietaire');
}

// ── Espace locataire ──────────────────────────────────────────────────────

/**
 * Fils du locataire : un par propriétaire chez qui il loue. Ils sont créés
 * ici s'ils n'existent pas (une requête, idempotente) : le locataire doit
 * pouvoir écrire le premier, et son application affiche d'emblée une
 * conversation par propriétaire.
 */
async function listerFilsLocataire(tenantIds, { limit, offset }) {
  await sequelize.query(
    `INSERT INTO message_threads (owner_id, tenant_id)
     SELECT owner_id, id FROM tenants WHERE id IN (:tenantIds) AND deleted_at IS NULL
     ON CONFLICT (owner_id, tenant_id) DO NOTHING`,
    { replacements: { tenantIds } }
  );
  const [lignes, total] = await Promise.all([
    sequelize.query(
      `SELECT ${SELECT_FILS}, o.display_name AS owner_name
       FROM message_threads th
       JOIN owners o ON o.id = th.owner_id
       ${LATERAL_DERNIER}
       WHERE th.tenant_id IN (:tenantIds)
       ORDER BY th.last_message_at DESC NULLS LAST, th.id
       LIMIT :limit OFFSET :offset`,
      { replacements: { tenantIds, roleAutre: 'proprietaire', limit, offset }, type: QueryTypes.SELECT }
    ),
    MessageThread.count({ where: { tenant_id: { [Op.in]: tenantIds } } }),
  ]);
  return {
    rows: lignes.map((l) => filVersApi(l, { owner: { id: l.owner_id, display_name: l.owner_name }, tenant_id: l.tenant_id })),
    count: total,
  };
}

async function messagesFilLocataire(threadId, tenantIds, pagination) {
  const thread = await chargerPourLocataire(MessageThread, threadId, tenantIds, {}, 'Fil de discussion');
  return listerMessages(thread.id, pagination);
}

/**
 * Message du locataire dans l'un de SES fils. La messagerie doit être incluse
 * dans la formule (active) du propriétaire : c'est lui qui la paie (§ 31).
 */
async function envoyerLocataire(threadId, tenantIds, user, donnees, fichier = null) {
  const thread = await chargerPourLocataire(MessageThread, threadId, tenantIds, {}, 'Fil de discussion');
  if (!(await droits.aFonctionnalite(thread.owner_id, 'messagerie'))) {
    throw new ForbiddenError("La messagerie n'est pas disponible pour ce logement.", 'MESSAGERIE_INDISPONIBLE');
  }
  const tenant = await Tenant.findByPk(thread.tenant_id, { attributes: ['id', 'owner_id', 'user_id', 'first_name', 'last_name'], paranoid: false });
  await verifierRattachement(donnees, thread.owner_id, thread.tenant_id);
  return enregistrer({
    ownerId: thread.owner_id, tenant, auteur: user, role: 'locataire', donnees, fichier, threadId: thread.id,
  });
}

async function marquerLuLocataire(threadId, tenantIds) {
  const thread = await chargerPourLocataire(MessageThread, threadId, tenantIds, { attributes: ['id', 'tenant_id'] }, 'Fil de discussion');
  return marquerLus(thread.id, 'locataire');
}

// ── Dossier locataire ─────────────────────────────────────────────────────

/**
 * Historique des échanges d'un locataire, pour le journal de son dossier
 * (§ 54.1). Aucun contrôle d'accès ici : l'appelant (service du dossier
 * locataire) a déjà chargé la fiche avec chargerPourProprietaire.
 *
 * @param {string} ownerId
 * @param {string} tenantId
 * @param {{ limit: number, offset: number }} pagination
 * @returns {Promise<{ rows: object[], count: number }>}
 */
async function historiquePourLocataire(ownerId, tenantId, pagination) {
  const thread = await MessageThread.findOne({ where: { owner_id: ownerId, tenant_id: tenantId }, attributes: ['id'] });
  if (!thread) return { rows: [], count: 0 };
  return listerMessages(thread.id, pagination);
}

module.exports = {
  listerFils, messagesFil, envoyerProprietaire, marquerLuProprietaire,
  listerFilsLocataire, messagesFilLocataire, envoyerLocataire, marquerLuLocataire,
  historiquePourLocataire, verifierRattachement,
};
