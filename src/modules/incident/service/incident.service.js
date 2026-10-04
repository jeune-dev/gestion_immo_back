'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Incident, Building, Apartment, Tenant, Lease, WorkOrder, Contractor,
} = require('../../../models/index.js');
const { chargerPourProprietaire, chargerPourLocataire, verifierReference } = require('../../../utils/acces.js');
const { ordre, rechercheTexte } = require('../../../utils/liste.js');
const { prochainNumero, pad } = require('../../../utils/compteur.js');
const { aujourdhui, ajouterJours } = require('../../../utils/dates.js');
const { ConflictError, ValidationError } = require('../../../errors/AppError.js');
const { VIDEOS } = require('../../../middlewares/upload.middleware.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const documents = require('../../document/service/document.service.js');
const travaux = require('../../travaux/service/travaux.service.js');
const { appliquerStatut } = require('./incidentStatut.service.js');
const { notifier, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');

/**
 * Incidents (§ 22) et leur workflow (§ 23) :
 *
 *   1 locataire signale → 2 propriétaire notifié → 3 analyse (en_analyse)
 *   → 4 création / validation des travaux (travaux_planifies)
 *   → 5-7 intervention, photos, dépense (module travaux)
 *   → 8 travail terminé ⇒ incident résolu (module travaux)
 *   ; rejet motivé possible tant que l'incident n'est pas clos.
 *
 * Chaque changement de statut passe par `incidentStatut.appliquerStatut`
 * (transition vérifiée, audit, notification du locataire).
 *
 * Le propriétaire peut aussi déclarer lui-même un incident de PARTIE COMMUNE
 * (sans locataire). Le locataire ne voit que SES demandes (« Mes demandes »,
 * § 28), jamais celles des autres.
 */

/** Pièces jointes du locataire acceptées tant que l'incident n'est pas traité. */
const STATUTS_PIECES = ['signale', 'en_analyse'];

/** Catégorie d'incident (§ 22) → catégorie de travaux (§ 18) proposée par défaut. */
const CATEGORIE_TRAVAUX_PAR_INCIDENT = Object.freeze({
  fuite: 'plomberie',
  plomberie: 'plomberie',
  panne_electrique: 'electricite',
  climatisation: 'climatisation',
  serrure: 'serrurerie',
  porte: 'menuiserie',
  probleme_commun: 'autre',
  autre: 'autre',
});

const INCLUDE_LISTE = [
  { model: Building, as: 'building', attributes: ['id', 'name'], paranoid: false },
  { model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false },
];
const INCLUDE_PROPRIETAIRE = [
  ...INCLUDE_LISTE,
  { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone'], paranoid: false },
];
/** Vue locataire : la note interne du propriétaire n'est pas exposée. */
const ATTRIBUTS_LOCATAIRE = { exclude: ['owner_note', 'owner_id', 'reported_by'] };

async function referenceSuivante(ownerId, t) {
  const annee = aujourdhui().slice(0, 4);
  const numero = await prochainNumero(`owner:${ownerId}:incident:${annee}`, t);
  return `INC-${annee}-${pad(numero)}`;
}

/** Travaux liés à un incident (suivi de l'intervention). */
function travauxLies(incidentId, ownerId, attributs) {
  return WorkOrder.findAll({
    where: { incident_id: incidentId, owner_id: ownerId },
    attributes: attributs,
    include: [{ model: Contractor, as: 'contractor', attributes: ['id', 'name', 'trade'], paranoid: false }],
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  }).then((lignes) => lignes.map(travaux.versApi));
}

// ── Espace propriétaire ─────────────────────────────────────────────────────

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['status', 'category', 'building_id', 'apartment_id', 'tenant_id']) if (f[cle]) where[cle] = f[cle];
  const texte = rechercheTexte(f.q, ['title', 'reference']);
  if (texte) Object.assign(where, texte);
  if (f.du || f.au) {
    where.created_at = {};
    if (f.du) where.created_at[Op.gte] = f.du;
    if (f.au) where.created_at[Op.lt] = ajouterJours(f.au, 1);
  }
  return Incident.findAndCountAll({ where, include: INCLUDE_PROPRIETAIRE, order: ordre(f.tri, '-created_at'), limit, offset });
}

async function detail(id, ownerId) {
  const incident = await chargerPourProprietaire(Incident, id, ownerId, { include: INCLUDE_PROPRIETAIRE }, 'Incident');
  const [pieces, workOrders] = await Promise.all([
    documents.listerPourEntite('incident', id),
    travauxLies(id, ownerId, ['id', 'number', 'title', 'status', 'priority', 'estimated_amount', 'actual_amount', 'scheduled_for', 'completed_at', 'created_at']),
  ]);
  return { ...incident.toJSON(), documents: pieces.map(documents.versApi), work_orders: workOrders };
}

/** Incident de partie commune déclaré par le propriétaire (sans locataire). */
async function creer(ownerId, user, d) {
  const incident = await sequelize.transaction(async (t) => {
    const building = await verifierReference(Building, d.building_id, ownerId, 'Immeuble', { transaction: t });
    if (d.apartment_id) {
      const apartment = await verifierReference(Apartment, d.apartment_id, ownerId, 'Appartement', { transaction: t });
      if (apartment.building_id !== building.id) throw new ValidationError('Données invalides', ["L'appartement n'appartient pas à l'immeuble"]);
    }
    const cree = await Incident.create({
      owner_id: ownerId, tenant_id: null, lease_id: null, building_id: building.id, apartment_id: d.apartment_id || null,
      reference: await referenceSuivante(ownerId, t), category: d.category, title: d.title, description: d.description,
      status: 'signale', reported_by: user.id,
    }, { transaction: t });
    await journaliser({ action: 'incident.creation', entityType: 'incident', entityId: cree.id, ownerId, details: { reference: cree.reference, categorie: cree.category, building_id: cree.building_id } }, t);
    const destinataires = (await destinatairesProprietaire(ownerId, t)).filter((x) => x.userId !== user.id);
    if (destinataires.length) {
      await notifier(t, {
        destinataires, ownerId, type: 'incident',
        titre: `Incident ${cree.reference} signalé`, corps: cree.title, donnees: { incident_id: cree.id },
      });
    }
    return cree;
  });
  return detail(incident.id, ownerId);
}

/** Transition simple (analyse, rejet, résolution) sur l'incident verrouillé. */
async function transition(id, ownerId, vers, options) {
  await sequelize.transaction(async (t) => {
    const incident = await chargerPourProprietaire(Incident, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Incident');
    await appliquerStatut(t, incident, vers, options);
  });
  return detail(id, ownerId);
}

const analyser = (id, ownerId, { note } = {}) => transition(id, ownerId, 'en_analyse', { note });
const rejeter = (id, ownerId, { reason, note } = {}) => transition(id, ownerId, 'rejete', { motif: reason, note });
const resoudre = (id, ownerId, { note } = {}) => transition(id, ownerId, 'resolu', { note });

/**
 * § 23 étape 4 — « Création / validation des travaux » depuis l'incident.
 * Le chantier reprend l'immeuble, l'appartement, le titre et la description de
 * l'incident (surchargeables), naît « validé » (le propriétaire vient de
 * l'analyser) et l'incident passe « travaux planifiés ». Un second chantier
 * pour un incident déjà planifié est permis (sans nouvelle transition).
 */
async function creerTravaux(id, ownerId, user, d) {
  const wo = await sequelize.transaction(async (t) => {
    const incident = await chargerPourProprietaire(Incident, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Incident');
    if (d.building_id && d.building_id !== incident.building_id) {
      throw new ValidationError('Données invalides', ["Les travaux d'un incident concernent l'immeuble de l'incident"]);
    }
    if (incident.status !== 'travaux_planifies') {
      await appliquerStatut(t, incident, 'travaux_planifies', { note: d.note });
    }
    return travaux.creerDansTransaction(t, ownerId, user, {
      ...d,
      building_id: incident.building_id,
      apartment_id: d.apartment_id === undefined ? incident.apartment_id : d.apartment_id,
      title: d.title || incident.title.slice(0, 150),
      description: d.description === undefined ? incident.description : d.description,
      category: d.category || CATEGORIE_TRAVAUX_PAR_INCIDENT[incident.category] || 'autre',
      status: d.status || 'valide',
    }, incident);
  });
  return travaux.detail(wo.id, ownerId);
}

// ── Espace locataire ────────────────────────────────────────────────────────

/** « Mes demandes » (§ 28) : uniquement les incidents des fiches du compte. */
async function listerPourLocataire(tenantIds, f, { limit, offset }) {
  const where = { tenant_id: { [Op.in]: tenantIds } };
  if (f.status) where.status = f.status;
  return Incident.findAndCountAll({
    where, attributes: ATTRIBUTS_LOCATAIRE, include: INCLUDE_LISTE, order: [['created_at', 'DESC'], ['id', 'ASC']], limit, offset,
  });
}

async function detailPourLocataire(id, tenantIds) {
  const incident = await chargerPourLocataire(Incident, id, tenantIds, { attributes: { exclude: ['owner_note', 'reported_by'] }, include: INCLUDE_LISTE }, 'Incident');
  const [pieces, workOrders] = await Promise.all([
    documents.listerPourEntite('incident', id, { visiblesLocataireSeulement: true }),
    // Suivi de l'intervention sans les montants (donnée financière du propriétaire).
    travauxLies(id, incident.owner_id, ['id', 'number', 'title', 'status', 'scheduled_for', 'started_at', 'completed_at']),
  ]);
  const visible = incident.toJSON();
  delete visible.owner_id;
  return { ...visible, documents: pieces.map(documents.versApi), work_orders: workOrders };
}

/**
 * Bail concerné par le signalement : l'un des baux ACTIFS du locataire. Sans
 * précision, le bail actif unique ; plusieurs baux actifs (plusieurs
 * logements) → le client doit préciser `lease_id`.
 */
async function bailDuSignalement(tenantIds, leaseId, t) {
  const baux = await Lease.findAll({
    where: { tenant_id: { [Op.in]: tenantIds }, status: 'actif' },
    include: [{ model: Apartment, as: 'apartment', attributes: ['id', 'building_id'], paranoid: false }],
    transaction: t,
  });
  if (leaseId) {
    const bail = baux.find((b) => b.id === leaseId);
    if (!bail) throw new ValidationError('Données invalides', ['Ce bail ne fait pas partie de vos locations en cours'], 'BAIL_INVALIDE');
    return bail;
  }
  if (!baux.length) throw new ValidationError('Aucune location en cours : signalement impossible', [], 'AUCUN_BAIL_ACTIF');
  if (baux.length > 1) {
    throw new ValidationError('Vous avez plusieurs locations en cours : précisez le logement concerné (lease_id)', [], 'BAIL_A_PRECISER');
  }
  return baux[0];
}

/**
 * § 22 / § 23 étape 1-2 — signalement par le locataire, notification du
 * propriétaire. Synchronisation différée (§ 34) : une même `client_reference`
 * renvoie la demande déjà créée (l'Idempotency-Key couvre le double envoi
 * concurrent).
 *
 * @returns {Promise<{ incident: object, rejoue: boolean }>}
 */
async function signaler(tenantIds, user, d) {
  const dejaSynchronise = async () => {
    if (!d.client_reference) return null;
    const existant = await Incident.findOne({ where: { tenant_id: { [Op.in]: tenantIds }, client_reference: d.client_reference }, attributes: ['id'] });
    return existant ? { incident: await detailPourLocataire(existant.id, tenantIds), rejoue: true } : null;
  };
  const rejoue = await dejaSynchronise();
  if (rejoue) return rejoue;
  // Deux synchronisations SIMULTANÉES de la même demande hors ligne : l'index
  // unique (tenant_id, client_reference) arbitre, la perdante renvoie la
  // demande de la gagnante au lieu d'un 409.
  let cree;
  try {
    cree = await creerSignalement(tenantIds, user, d);
  } catch (err) {
    if (err instanceof UniqueConstraintError && d.client_reference) {
      const gagnante = await dejaSynchronise();
      if (gagnante) return gagnante;
    }
    throw err;
  }
  return { incident: await detailPourLocataire(cree.id, tenantIds), rejoue: false };
}

/** Création du signalement : incident, audit, notification du propriétaire — tout ou rien. */
function creerSignalement(tenantIds, user, d) {
  return sequelize.transaction(async (t) => {
    const bail = await bailDuSignalement(tenantIds, d.lease_id, t);
    const ownerId = bail.owner_id;
    const cree = await Incident.create({
      owner_id: ownerId,
      tenant_id: bail.tenant_id,
      lease_id: bail.id,
      building_id: bail.apartment.building_id,
      apartment_id: bail.apartment_id,
      reference: await referenceSuivante(ownerId, t),
      category: d.category,
      title: d.title,
      description: d.description,
      status: 'signale',
      reported_by: user.id,
      client_reference: d.client_reference || null,
    }, { transaction: t });
    await journaliser({
      action: 'incident.creation', entityType: 'incident', entityId: cree.id, ownerId,
      details: { reference: cree.reference, categorie: cree.category, tenant_id: cree.tenant_id, apartment_id: cree.apartment_id },
    }, t);
    await notifier(t, {
      destinataires: await destinatairesProprietaire(ownerId, t),
      ownerId,
      type: 'incident',
      titre: `Nouvel incident ${cree.reference}`,
      corps: `${cree.title} — ${cree.description}`.slice(0, 500),
      donnees: { incident_id: cree.id, apartment_id: cree.apartment_id },
    });
    return cree;
  });
}

/**
 * Photo ou vidéo jointe par le locataire (§ 22), partagée avec lui. Acceptée
 * tant que l'incident n'est ni planifié ni clos : au-delà, le suivi passe par
 * les photos d'intervention du chantier.
 */
async function ajouterPiece(id, tenantIds, user, fichier) {
  return transactionAvecFichiers(async (t) => {
    const incident = await chargerPourLocataire(Incident, id, tenantIds, { transaction: t, lock: t.LOCK.UPDATE }, 'Incident');
    if (!STATUTS_PIECES.includes(incident.status)) {
      throw new ConflictError('Cette demande est déjà prise en charge ou close : ajout de pièce impossible.', 'INCIDENT_PIECES_CLOSES');
    }
    const document = await documents.creerDocument({
      ownerId: incident.owner_id,
      tenantId: incident.tenant_id,
      entityType: 'incident',
      entityId: incident.id,
      category: VIDEOS.has(fichier.type) ? 'video' : 'photo',
      fichier,
      visibleToTenant: true,
      uploadedBy: user.id,
    }, t);
    return documents.versApi(document);
  });
}

module.exports = {
  lister, detail, creer, analyser, rejeter, resoudre, creerTravaux,
  listerPourLocataire, detailPourLocataire, signaler, ajouterPiece,
};
