'use strict';

const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Document, Building, Apartment, Tenant, Lease, Contractor, WorkOrder, Incident, Inspection,
  Expense, Deposit, ChargeInvoice, PaymentTransaction, Receipt,
} = require('../../../models/index.js');
const storage = require('../../../infrastructure/storage.service.js');
const { preparerImage } = require('../../../infrastructure/image.service.js');
const { IMAGES } = require('../../../middlewares/upload.middleware.js');
const {
  NotFoundError, ForbiddenError, ConflictError, ValidationError,
} = require('../../../errors/AppError.js');
const { chargerPourProprietaire } = require('../../../utils/acces.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const { notifier, destinataireLocataire } = require('../../notification/service/notification.service.js');

/**
 * Documents (§ 7 photos et documents d'immeuble, § 19 photos de travaux, § 20
 * justificatifs, § 22 photos/vidéos d'incident, § 52 photos d'état des lieux,
 * quittances et contrats générés).
 *
 * Point d'entrée UNIQUE vers le stockage objet : tout fichier de l'application
 * a sa ligne `documents` (propriétaire, locataire concerné, ressource de
 * rattachement), ce qui rend le contrôle d'accès uniforme (`verifierAcces`).
 */

/**
 * Enregistre un fichier reçu (ou généré) et crée sa ligne `documents`.
 * À appeler dans une transaction ouverte par `transactionAvecFichiers`.
 *
 * @param {object} p
 * @param {string|null} p.ownerId
 * @param {string|null} [p.tenantId]       locataire concerné (accès locataire)
 * @param {string} p.entityType
 * @param {string} p.entityId
 * @param {string} p.category
 * @param {{ buffer: Buffer, type: string, mime: string, nomOrigine?: string }} p.fichier
 * @param {boolean} [p.visibleToTenant]
 * @param {Date|string|null} [p.capturedAt] horodatage de prise de vue (mobile)
 * @param {string|null} [p.uploadedBy]
 * @param {import('sequelize').Transaction} t
 */
async function creerDocument({
  ownerId, tenantId = null, entityType, entityId, category, fichier,
  visibleToTenant = false, capturedAt = null, uploadedBy = null,
}, t) {
  const dossier = `owners/${ownerId || 'plateforme'}/${entityType}`;
  let contenu = fichier.buffer;
  let cleMiniature = null;

  if (IMAGES.has(fichier.type)) {
    const { original, miniature } = await preparerImage(fichier.buffer, fichier.type);
    contenu = original;
    cleMiniature = await storage.enregistrer(miniature, `${dossier}/miniatures`, 'webp', 'image/webp');
    t?.clesStockees?.push(cleMiniature);
  }

  const cle = await storage.enregistrer(contenu, dossier, fichier.type, fichier.mime);
  t?.clesStockees?.push(cle);

  const document = await Document.create({
    owner_id: ownerId,
    tenant_id: tenantId,
    entity_type: entityType,
    entity_id: entityId,
    category,
    storage_key: cle,
    thumbnail_key: cleMiniature,
    mime_type: fichier.mime,
    size_bytes: contenu.length,
    original_name: fichier.nomOrigine || null,
    checksum: crypto.createHash('sha256').update(contenu).digest('hex'),
    visible_to_tenant: visibleToTenant,
    captured_at: capturedAt || null,
    uploaded_by: uploadedBy,
  }, { transaction: t });

  await journaliser({
    action: `${entityType}.ajout_document`,
    entityType,
    entityId,
    ownerId,
    details: { document_id: document.id, categorie: category, taille: contenu.length },
  }, t);

  return document;
}

/**
 * Vérifie qu'un utilisateur peut lire un document.
 *   - propriétaire (membre de l'espace) : tout document de son espace ;
 *   - locataire : uniquement les documents qui le concernent ET partagés ;
 *   - super admin : aucun accès aux fichiers privés des propriétaires
 *     (minimisation — il n'en a pas besoin pour administrer la plateforme).
 */
function verifierAcces(document, { ownerId, tenantIds }) {
  if (ownerId && document.owner_id === ownerId) return;
  if (tenantIds?.length && document.visible_to_tenant && tenantIds.includes(document.tenant_id)) return;
  throw new ForbiddenError("Vous n'avez pas accès à ce document.", 'ACCES_DOCUMENT_REFUSE');
}

async function charger(id) {
  const document = await Document.findByPk(id);
  if (!document) throw new NotFoundError('Document introuvable');
  return document;
}

/** Documents rattachés à une ressource (sans le contenu). */
async function listerPourEntite(entityType, entityId, { visiblesLocataireSeulement = false } = {}) {
  const where = { entity_type: entityType, entity_id: entityId };
  if (visiblesLocataireSeulement) where.visible_to_tenant = true;
  return Document.findAll({
    where,
    attributes: ['id', 'category', 'mime_type', 'size_bytes', 'original_name', 'thumbnail_key', 'visible_to_tenant', 'captured_at', 'created_at'],
    order: [['created_at', 'ASC']],
  });
}

/** Représentation d'API : jamais la clé de stockage elle-même. */
function versApi(document) {
  return {
    id: document.id,
    category: document.category,
    mime_type: document.mime_type,
    size_bytes: document.size_bytes,
    original_name: document.original_name,
    has_thumbnail: Boolean(document.thumbnail_key),
    visible_to_tenant: document.visible_to_tenant,
    captured_at: document.captured_at,
    created_at: document.created_at,
    url: `/api/v1/documents/${document.id}/fichier`,
  };
}

// ── Gestion des documents par l'API /documents ────────────────────────────

/**
 * Ressources auxquelles le propriétaire peut rattacher un fichier À LA MAIN
 * (§ 7 photos et documents d'immeuble, § 8 appartement, § 9 pièce d'identité
 * du locataire, § 10 document du contrat, § 24 artisan). Les autres
 * rattachements (travaux, incident, état des lieux, dépense, caution, message,
 * paiement, quittance) sont produits par LEUR module, qui porte les règles
 * métier associées (phase de la photo, justificatif de retenue…).
 */
const ENTITES_MANUELLES = Object.freeze({
  building: { Modele: Building, libelle: 'Immeuble' },
  apartment: { Modele: Apartment, libelle: 'Appartement' },
  tenant: { Modele: Tenant, libelle: 'Locataire' },
  lease: { Modele: Lease, libelle: 'Bail' },
  contractor: { Modele: Contractor, libelle: 'Artisan' },
});

/** Catégories admises pour un téléversement manuel. */
const CATEGORIES_MANUELLES = Object.freeze(['photo', 'contrat', 'justificatif', 'piece_identite', 'autre']);

/**
 * Catégories supprimables. Un contrat (§ 10, § 53), une quittance (§ 13), un
 * état des lieux (§ 52), une preuve de paiement ou un reçu (§ 12, § 55) sont
 * des pièces probantes : jamais supprimées, même logiquement (§ 42).
 */
const CATEGORIES_SUPPRIMABLES = Object.freeze(['photo', 'piece_identite', 'autre', 'justificatif', 'facture']);

/**
 * Toutes les ressources rattachables et leur modèle, pour vérifier qu'un
 * propriétaire qui liste les documents d'une ressource en est bien le
 * titulaire (§ 32, § 43 → 403). `message` n'a pas de colonne `owner_id` : ses
 * documents sont protégés par le filtre `documents.owner_id` de la requête.
 */
const MODELES_ENTITE = Object.freeze({
  ...ENTITES_MANUELLES,
  work_order: { Modele: WorkOrder, libelle: 'Travaux' },
  incident: { Modele: Incident, libelle: 'Incident' },
  inspection: { Modele: Inspection, libelle: 'État des lieux' },
  expense: { Modele: Expense, libelle: 'Dépense' },
  deposit: { Modele: Deposit, libelle: 'Caution' },
  charge_invoice: { Modele: ChargeInvoice, libelle: 'Facture commune' },
  payment_transaction: { Modele: PaymentTransaction, libelle: 'Transaction' },
  receipt: { Modele: Receipt, libelle: 'Quittance' },
});

/** Locataire concerné par une ressource (accès locataire au document). */
function locataireDeLEntite(entityType, entite) {
  if (entityType === 'tenant') return entite.id;
  if (entityType === 'lease') return entite.tenant_id;
  return null;
}

/** Notification « document disponible » (§ 27) au locataire concerné. */
async function notifierPartage(document, t) {
  const tenant = await Tenant.findByPk(document.tenant_id, { attributes: ['id', 'user_id'], paranoid: false, transaction: t });
  if (!tenant) return;
  await notifier(t, {
    destinataires: [destinataireLocataire(tenant)],
    ownerId: document.owner_id,
    type: 'document_disponible',
    titre: 'Nouveau document disponible',
    corps: `Un document (${document.original_name || document.category}) a été partagé avec vous.`,
    donnees: { document_id: document.id, entity_type: document.entity_type, entity_id: document.entity_id },
  });
}

/**
 * Téléversement manuel par le propriétaire.
 * @param {string} ownerId
 * @param {{ id: string }} user
 * @param {{ entity_type: string, entity_id: string, category: string, visible_to_tenant?: boolean, captured_at?: Date }} donnees
 * @param {{ buffer: Buffer, type: string, mime: string, nomOrigine?: string }} fichier
 */
async function televerser(ownerId, user, donnees, fichier) {
  const { Modele, libelle } = ENTITES_MANUELLES[donnees.entity_type];
  const entite = await chargerPourProprietaire(Modele, donnees.entity_id, ownerId, {}, libelle);
  const tenantId = locataireDeLEntite(donnees.entity_type, entite);
  const visible = Boolean(donnees.visible_to_tenant);
  // Partager un document sans locataire concerné n'aurait aucun effet : aucun
  // locataire ne pourrait le lire (verifierAcces exige `tenant_id`).
  if (visible && !tenantId) {
    throw new ValidationError('Données invalides', ['Seul un document rattaché à un locataire ou à un bail peut être partagé avec le locataire']);
  }

  const document = await transactionAvecFichiers(async (t) => {
    const cree = await creerDocument({
      ownerId,
      tenantId,
      entityType: donnees.entity_type,
      entityId: entite.id,
      category: donnees.category,
      fichier,
      visibleToTenant: visible,
      capturedAt: donnees.captured_at || null,
      uploadedBy: user.id,
    }, t);
    if (visible) await notifierPartage(cree, t);
    return cree;
  });
  return versApi(document);
}

/**
 * Liste paginée des documents visibles par l'appelant.
 *   - propriétaire : les documents de son espace ; si une ressource est
 *     désignée, elle doit lui appartenir (403 sinon) ;
 *   - locataire : uniquement les documents partagés qui le concernent.
 * @param {{ ownerId?: string|null, tenantIds?: string[]|null }} acces
 */
async function lister(acces, { entity_type: entityType, entity_id: entityId } = {}, { limit, offset }) {
  const where = {};
  if (acces.tenantIds) {
    where.tenant_id = { [Op.in]: acces.tenantIds };
    where.visible_to_tenant = true;
  } else {
    if (entityType && MODELES_ENTITE[entityType]) {
      const { Modele, libelle } = MODELES_ENTITE[entityType];
      await chargerPourProprietaire(Modele, entityId, acces.ownerId, { attributes: ['id', 'owner_id'] }, libelle);
    }
    where.owner_id = acces.ownerId;
  }
  if (entityType) {
    where.entity_type = entityType;
    where.entity_id = entityId;
  }
  const { rows, count } = await Document.findAndCountAll({
    where,
    order: [['created_at', 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
  return { rows: rows.map(versApi), count };
}

/** Extension de repli (nom de fichier) déduite du type MIME stocké. */
const EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
};

/**
 * En-tête Content-Disposition SÛR : le nom d'origine vient du client et
 * pourrait contenir guillemets, retours chariot (injection d'en-tête) ou
 * caractères non ASCII. Il est nettoyé, puis transmis deux fois : une version
 * ASCII de repli (`filename`) et la version exacte encodée RFC 5987
 * (`filename*`).
 */
function dispositionInline(document, miniature) {
  const extension = miniature ? 'webp' : (EXTENSIONS[document.mime_type] || 'bin');
  let nom = String(document.original_name || '')
    .replace(/["\\\u0000-\u001f\u007f]/g, '')
    .replace(/[/]/g, '_')
    .trim()
    .slice(0, 150);
  if (!nom) nom = `document-${document.id}.${extension}`;
  if (miniature) nom = `miniature-${nom.replace(/\.[^.]*$/, '')}.webp`;
  const ascii = nom.replace(/[^\x20-\x7e]/g, '_');
  const encode = encodeURIComponent(nom).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encode}`;
}

/**
 * Ouvre le fichier d'un document après contrôle d'accès (§ 37 « URL
 * sécurisée » : le fichier ne sort jamais sans passer par verifierAcces).
 * La miniature (§ 37 « chargement basse résolution puis haute résolution »)
 * est servie si elle est demandée et existe ; sinon l'original.
 *
 * @returns {Promise<{ objet: { stream: NodeJS.ReadableStream, taille?: number }, mime: string, disposition: string }>}
 */
async function ouvrirFichier(id, acces, { miniature = false } = {}) {
  const document = await charger(id);
  verifierAcces(document, acces);
  const servirMiniature = miniature && Boolean(document.thumbnail_key);
  const objet = await storage.ouvrir(servirMiniature ? document.thumbnail_key : document.storage_key);
  if (!objet) throw new NotFoundError('Fichier introuvable dans le stockage', 'FICHIER_INTROUVABLE');
  return {
    objet,
    mime: servirMiniature ? 'image/webp' : document.mime_type,
    disposition: dispositionInline(document, servirMiniature),
  };
}

const DUREE_LIEN_S = 300;

/**
 * Lien de téléchargement direct.
 *   - Stockage R2 : URL signée de 5 minutes — le fichier est servi par R2 sans
 *     solliciter l'API, et le lien expire vite s'il est partagé.
 *   - Stockage disque (développement, tests) : il n'existe pas d'URL signée ;
 *     le lien renvoyé est la route de flux authentifiée, qui applique le même
 *     contrôle d'accès à chaque appel (`expires_in: null`).
 */
async function lienTemporaire(id, acces, { miniature = false } = {}) {
  const document = await charger(id);
  verifierAcces(document, acces);
  const servirMiniature = miniature && Boolean(document.thumbnail_key);
  const url = await storage.urlTemporaire(servirMiniature ? document.thumbnail_key : document.storage_key, DUREE_LIEN_S);
  if (url) return { url, expires_in: DUREE_LIEN_S };
  return {
    url: `/api/v1/documents/${document.id}/fichier${servirMiniature ? '?taille=miniature' : ''}`,
    expires_in: null,
  };
}

/**
 * Partage (ou retrait du partage) d'un document avec le locataire concerné.
 * Le partage notifie le locataire (§ 27 « Document disponible »).
 *
 * Seuls les documents téléversés À LA MAIN (ENTITES_MANUELLES) se partagent
 * ou se retirent ici : la visibilité des pièces produites par un module
 * (photo d'état des lieux, reçu de caution, preuve de paiement…) est décidée
 * par ce module — rendre visible la photo d'un brouillon d'état des lieux
 * contournerait § 52.3. Et une pièce probante déjà partagée (contrat, pièce
 * référencée par un contrat généré, un état des lieux, une caution, un
 * paiement…) ne peut JAMAIS être retirée au locataire : ce serait lui
 * soustraire une preuve (§ 52.4, § 55.4) → 409 DOCUMENT_PROTEGE.
 */
async function modifier(id, ownerId, { visible_to_tenant: visible }) {
  return sequelize.transaction(async (t) => {
    const document = await chargerPourProprietaire(Document, id, ownerId, { lock: t.LOCK.UPDATE, transaction: t }, 'Document');
    if (visible === document.visible_to_tenant) return versApi(document);
    if (!ENTITES_MANUELLES[document.entity_type] || !CATEGORIES_MANUELLES.includes(document.category)) {
      throw new ConflictError(
        'La visibilité de ce document est fixée par le module qui l’a produit : elle ne se modifie pas ici.',
        'DOCUMENT_PROTEGE',
        { category: document.category, entity_type: document.entity_type }
      );
    }
    if (!visible) {
      const liens = await references(document.id, t);
      if (!CATEGORIES_SUPPRIMABLES.includes(document.category) || liens.length) {
        throw new ConflictError(
          'Ce document est une pièce probante partagée avec le locataire : son partage ne peut pas être retiré.',
          'DOCUMENT_PROTEGE',
          { category: document.category, references: liens }
        );
      }
    }
    if (visible && !document.tenant_id) {
      throw new ValidationError('Données invalides', ['Ce document ne concerne aucun locataire : il ne peut pas être partagé']);
    }
    const avant = document.visible_to_tenant;
    await document.update({ visible_to_tenant: visible }, { transaction: t });
    await journaliser({
      action: 'document.modification',
      entityType: 'document',
      entityId: document.id,
      ownerId,
      details: { visible_to_tenant: { avant, apres: visible } },
    }, t);
    if (visible) await notifierPartage(document, t);
    return versApi(document);
  });
}

/**
 * Références qui rendent un document intouchable : pièce d'un contrat généré,
 * photo d'un travail terminé ou d'un état des lieux accepté (§ 52 « état
 * accepté non modifiable »), quittance, preuve de paiement, reçu ou
 * justificatif de caution (§ 55), pièce d'un message (§ 54.1 « historique
 * conservé »). Une seule requête, un EXISTS par référence.
 */
async function references(id, t) {
  const [r] = await sequelize.query(
    `SELECT
       EXISTS (SELECT 1 FROM lease_documents WHERE document_id = :id) AS contrat,
       EXISTS (SELECT 1 FROM work_photos wp JOIN work_orders wo ON wo.id = wp.work_order_id
               WHERE wp.document_id = :id AND wo.status = 'termine') AS travaux_termines,
       EXISTS (SELECT 1 FROM inspection_photos ip JOIN inspections i ON i.id = ip.inspection_id
               WHERE ip.document_id = :id AND i.status = 'accepte') AS etat_des_lieux_accepte,
       EXISTS (SELECT 1 FROM inspections WHERE document_id = :id) AS etat_des_lieux,
       EXISTS (SELECT 1 FROM receipts WHERE document_id = :id) AS quittance,
       EXISTS (SELECT 1 FROM payment_transactions WHERE proof_document_id = :id) AS preuve_paiement,
       EXISTS (SELECT 1 FROM deposit_transactions
               WHERE receipt_document_id = :id OR CAST(:id AS uuid) = ANY (justification_document_ids)) AS caution,
       EXISTS (SELECT 1 FROM messages WHERE document_id = :id) AS message`,
    { replacements: { id }, type: QueryTypes.SELECT, transaction: t }
  );
  return Object.keys(r).filter((cle) => r[cle]);
}

/**
 * Suppression LOGIQUE (paranoid) d'un document téléversé à la main. L'objet
 * stocké est conservé : la ligne reste restaurable et traçable (§ 40, § 42).
 */
async function supprimer(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const document = await chargerPourProprietaire(Document, id, ownerId, { lock: t.LOCK.UPDATE, transaction: t }, 'Document');
    if (!CATEGORIES_SUPPRIMABLES.includes(document.category) || !ENTITES_MANUELLES[document.entity_type]) {
      throw new ConflictError('Ce document est une pièce probante : il ne peut pas être supprimé.', 'DOCUMENT_PROTEGE', { category: document.category, entity_type: document.entity_type });
    }
    const liens = await references(document.id, t);
    if (liens.length) {
      throw new ConflictError('Ce document est référencé par une opération : il ne peut pas être supprimé.', 'DOCUMENT_PROTEGE', { references: liens });
    }
    await document.destroy({ transaction: t });
    await journaliser({
      action: 'document.suppression',
      entityType: 'document',
      entityId: document.id,
      ownerId,
      details: {
        categorie: document.category, rattachement: document.entity_type, rattachement_id: document.entity_id, nom: document.original_name,
      },
    }, t);
  });
}

module.exports = {
  creerDocument, verifierAcces, charger, listerPourEntite, versApi,
  televerser, lister, ouvrirFichier, lienTemporaire, modifier, supprimer,
  ENTITES_MANUELLES, CATEGORIES_MANUELLES, CATEGORIES_SUPPRIMABLES,
};
