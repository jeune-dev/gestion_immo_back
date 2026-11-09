'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Lease, LeaseAmendment, LeaseDocument, Apartment, Building, Owner, Tenant, RentSchedule,
} = require('../../../models/index.js');
const { MOIS_PAR_PERIODICITE } = require('../../../config/enums.js');
const { chargerPourProprietaire, chargerPourLocataire } = require('../../../utils/acces.js');
const { aujourdhui, ajouterJours, ajouterMois, ecartJours, formatFr } = require('../../../utils/dates.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { ConflictError, ValidationError, NotFoundError } = require('../../../errors/AppError.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const echeances = require('../../loyer/service/echeance.service.js');
const parametres = require('../../parametres/service/parametres.service.js');
const documents = require('../../document/service/document.service.js');
const { notifier, destinataireLocataire, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const logger = require('../../../utils/logger.js');

/**
 * Ce que le locataire accepte, et quand.
 *
 *   - Bail : le propriétaire PROPOSE le brouillon ; le locataire l'accepte ou
 *     le refuse dans son espace, ou le propriétaire joint le bail signé sur
 *     papier. Selon `lease_acceptance_policy`, l'activation exige cet accord.
 *     Toute modification du brouillon efface l'accord : le locataire n'a pas
 *     accepté la nouvelle version.
 *   - Loyer : un changement est un AVENANT proposé, avec une date d'effet au
 *     moins `rent_change_notice_days` jours plus tard. Il ne s'applique aux
 *     échéances qu'après l'accord du locataire (application ou papier signé).
 *     Refusé, le bail continue aux conditions d'origine.
 *   - Congé : l'une ou l'autre partie l'annonce avec une date de sortie qui
 *     respecte le préavis du bail. Les alertes de fin de bail rappellent la
 *     date aux deux parties ; la fin elle-même s'enregistre le jour du départ.
 */

const NOTICE = 'bail';

function nomLocataire(tenant) {
  return `${tenant.first_name} ${tenant.last_name}`.trim();
}

async function locataireDu(lease, t) {
  return Tenant.findByPk(lease.tenant_id, { attributes: ['id', 'user_id', 'first_name', 'last_name'], paranoid: false, transaction: t });
}

async function prevenirLocataire(t, lease, tenant, titre, corps, donnees = {}) {
  await notifier(t, {
    destinataires: [destinataireLocataire(tenant)], ownerId: lease.owner_id, type: NOTICE,
    titre, corps, donnees: { lease_id: lease.id, ...donnees },
  });
}

async function prevenirProprietaire(t, lease, titre, corps, donnees = {}) {
  await notifier(t, {
    destinataires: await destinatairesProprietaire(lease.owner_id, t), ownerId: lease.owner_id, type: NOTICE,
    titre, corps, donnees: { lease_id: lease.id, ...donnees },
  });
}

/** Pièce signée jointe par le propriétaire (bail ou avenant), visible du locataire. */
async function rangerPieceSignee(t, { lease, user, fichier, nom }) {
  if (!fichier) {
    throw new ValidationError('Données invalides', ['Joignez le document signé par le locataire (champ « fichier »).'], 'DOCUMENT_SIGNE_REQUIS');
  }
  return documents.creerDocument({
    ownerId: lease.owner_id, tenantId: lease.tenant_id, entityType: 'lease', entityId: lease.id, category: 'contrat',
    fichier: { ...fichier, nomOrigine: fichier.nomOrigine || nom }, visibleToTenant: true, uploadedBy: user.id,
  }, t);
}

// ── Accord sur le bail ──────────────────────────────────────────────────────

function exigerBrouillon(lease) {
  if (lease.status !== 'brouillon') {
    throw new ConflictError('Seul un bail en brouillon attend l’accord du locataire.', 'TRANSITION_INVALIDE');
  }
}

/** Le propriétaire présente le brouillon au locataire. */
async function proposer(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    exigerBrouillon(lease);
    if (lease.tenant_accepted_at) throw new ConflictError('Le locataire a déjà accepté ce bail.', 'BAIL_DEJA_ACCEPTE');
    await lease.update({ proposed_at: new Date(), tenant_refused_at: null, refusal_reason: null }, { transaction: t });
    const tenant = await locataireDu(lease, t);
    await journaliser({ action: 'bail.proposition', entityType: 'lease', entityId: id, ownerId, details: { reference: lease.reference, compte_locataire: Boolean(tenant.user_id) } }, t);
    await prevenirLocataire(t, lease, tenant, 'Bail à accepter',
      `Votre bailleur vous propose le bail ${lease.reference} : loyer de ${formatFcfa(lease.rent_amount)}, début le ${formatFr(lease.start_date)}. Lisez-le puis acceptez-le ou refusez-le dans votre espace.`);
    return { lease, tenant_has_account: Boolean(tenant.user_id) };
  });
}

/** Le locataire a signé le bail sur papier : le propriétaire joint le document. */
async function acceptationPapier(id, ownerId, user, fichier) {
  return transactionAvecFichiers(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    exigerBrouillon(lease);
    const piece = await rangerPieceSignee(t, { lease, user, fichier, nom: `${lease.reference}-signe` });
    await lease.update({
      tenant_accepted_at: new Date(), tenant_accepted_by: null, acceptance_method: 'papier', acceptance_document_id: piece.id,
      tenant_refused_at: null, refusal_reason: null, proposed_at: lease.proposed_at || new Date(),
    }, { transaction: t });
    await journaliser({ action: 'bail.acceptation', entityType: 'lease', entityId: id, ownerId, details: { methode: 'papier', document_id: piece.id } }, t);
    return { lease, document: documents.versApi(piece) };
  });
}

/** Champs d'un brouillon dont la modification remet l'accord à zéro. */
function accordAEffacer(lease) {
  return lease.proposed_at || lease.tenant_accepted_at || lease.tenant_refused_at;
}

const ACCORD_EFFACE = {
  proposed_at: null, tenant_accepted_at: null, tenant_accepted_by: null, tenant_refused_at: null,
  refusal_reason: null, acceptance_method: null, acceptance_document_id: null,
};

// ── Avenants de loyer ───────────────────────────────────────────────────────

/**
 * Recalcule les échéances NON ENCAISSÉES qui commencent à partir de la date
 * d'effet ; les autres restent intactes (historique financier).
 */
async function appliquerLoyer(t, lease, nouveau, effet) {
  const reglages = await parametres.proprietaire(lease.owner_id, t);
  // Les périodes antérieures à la date d'effet existent à l'ancien loyer avant
  // que le bail ne porte le nouveau (l'horizon glissant les créerait sinon au nouveau).
  await echeances.generer(lease, reglages, t, aujourdhui(), effet);
  const avant = { rent_amount: lease.rent_amount, charges_amount: lease.charges_amount };
  await lease.update(nouveau, { transaction: t });
  const aRecalculer = await RentSchedule.findAll({
    where: { lease_id: lease.id, period_start: { [Op.gte]: effet }, amount_paid: 0, status: { [Op.in]: ['a_venir', 'a_payer'] } },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  const mois = MOIS_PAR_PERIODICITE[lease.periodicity];
  for (const e of aRecalculer) {
    // Période pleine : nouveau montant × mois ; période proratisée : même ratio qu'avant.
    const ratio = e.rent_amount + e.charges_amount > 0 && avant.rent_amount + avant.charges_amount > 0
      ? (e.rent_amount + e.charges_amount) / ((avant.rent_amount + avant.charges_amount) * mois)
      : 1;
    const rent = Math.round(nouveau.rent_amount * mois * ratio);
    const ch = Math.round(nouveau.charges_amount * mois * ratio);
    await e.update({ rent_amount: rent, charges_amount: ch, amount_due: rent + ch }, { transaction: t });
  }
  return { avant, recalculees: aRecalculer.length };
}

async function chargerAvenant(leaseId, amendmentId, t) {
  const avenant = await LeaseAmendment.findByPk(amendmentId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!avenant || avenant.lease_id !== leaseId) throw new NotFoundError('Avenant introuvable');
  return avenant;
}

function exigerEnAttente(avenant) {
  if (avenant.status !== 'propose') {
    throw new ConflictError(`Cet avenant n'attend plus de réponse (« ${avenant.status} »).`, 'AVENANT_DEJA_TRAITE');
  }
}

/** Le propriétaire propose un nouveau loyer (et/ou de nouvelles charges). */
async function proposerAvenant(id, ownerId, user, { rent_amount: loyer, charges_amount: charges, effective_from: effet, reason }) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    if (lease.status !== 'actif') throw new ConflictError('Seul le loyer d’un bail actif se modifie par avenant.', 'TRANSITION_INVALIDE');
    const reglages = await parametres.proprietaire(ownerId, t);
    const auPlusTot = ajouterJours(aujourdhui(), reglages.rent_change_notice_days);
    if (effet < auPlusTot) {
      throw new ValidationError('Données invalides', [
        `Le locataire doit être prévenu au moins ${reglages.rent_change_notice_days} jours avant : date d'effet au plus tôt le ${formatFr(auPlusTot)}.`,
      ], 'PREAVIS_AVENANT_INSUFFISANT');
    }
    const nouveau = { rent_amount: loyer ?? lease.rent_amount, charges_amount: charges ?? lease.charges_amount };
    if (nouveau.rent_amount === lease.rent_amount && nouveau.charges_amount === lease.charges_amount) {
      throw new ValidationError('Données invalides', ['Le loyer et les charges proposés sont identiques aux montants actuels.'], 'AVENANT_SANS_CHANGEMENT');
    }
    let avenant;
    try {
      avenant = await LeaseAmendment.create({
        owner_id: ownerId, lease_id: id, tenant_id: lease.tenant_id,
        previous_rent_amount: lease.rent_amount, previous_charges_amount: lease.charges_amount,
        ...nouveau, effective_from: effet, reason: reason || null, proposed_by: user.id,
      }, { transaction: t });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw new ConflictError('Un avenant attend déjà la réponse du locataire : annulez-le avant d’en proposer un autre.', 'AVENANT_EN_ATTENTE');
      }
      throw err;
    }
    await journaliser({ action: 'bail.proposition_avenant', entityType: 'lease', entityId: id, ownerId, details: { avant: { rent_amount: lease.rent_amount, charges_amount: lease.charges_amount }, apres: nouveau, date_effet: effet } }, t);
    const tenant = await locataireDu(lease, t);
    const total = nouveau.rent_amount + nouveau.charges_amount;
    await prevenirLocataire(t, lease, tenant, 'Nouveau loyer proposé',
      `Votre bailleur propose ${formatFcfa(total)} par mois (charges comprises) à partir du ${formatFr(effet)}, au lieu de ${formatFcfa(lease.rent_amount + lease.charges_amount)}. Acceptez ou refusez dans votre espace.`,
      { amendment_id: avenant.id });
    return avenant;
  });
}

async function accepterDansTransaction(t, avenant, lease, { methode, userId = null, documentId = null }) {
  if (lease.status !== 'actif') throw new ConflictError('Le bail n’est plus actif : l’avenant ne peut plus s’appliquer.', 'BAIL_INVALIDE');
  // Accepté après la date prévue : le nouveau loyer part du jour de l'accord, jamais en arrière.
  const effet = avenant.effective_from > aujourdhui() ? avenant.effective_from : aujourdhui();
  const { avant, recalculees } = await appliquerLoyer(t, lease, { rent_amount: avenant.rent_amount, charges_amount: avenant.charges_amount }, effet);
  await avenant.update({
    status: 'accepte', acceptance_method: methode, acceptance_document_id: documentId,
    responded_at: new Date(), responded_by: userId, applied_schedules: recalculees,
  }, { transaction: t });
  await journaliser({
    action: 'bail.modification_loyer', entityType: 'lease', entityId: lease.id, ownerId: lease.owner_id,
    details: { avenant: avenant.id, methode, avant, apres: { rent_amount: avenant.rent_amount, charges_amount: avenant.charges_amount }, date_effet: effet, echeances_recalculees: recalculees },
  }, t);
  return { avenant, echeances_recalculees: recalculees };
}

/** Avenant signé sur papier : le propriétaire joint le document, le loyer s'applique. */
async function avenantPapier(id, amendmentId, ownerId, user, fichier) {
  return transactionAvecFichiers(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    const avenant = await chargerAvenant(id, amendmentId, t);
    exigerEnAttente(avenant);
    const piece = await rangerPieceSignee(t, { lease, user, fichier, nom: `${lease.reference}-avenant` });
    return accepterDansTransaction(t, avenant, lease, { methode: 'papier', documentId: piece.id });
  });
}

async function annulerAvenant(id, amendmentId, ownerId) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    const avenant = await chargerAvenant(id, amendmentId, t);
    exigerEnAttente(avenant);
    await avenant.update({ status: 'annule', responded_at: new Date() }, { transaction: t });
    await journaliser({ action: 'bail.annulation_avenant', entityType: 'lease', entityId: id, ownerId, details: { avenant: avenant.id } }, t);
    await prevenirLocataire(t, lease, await locataireDu(lease, t), 'Proposition de loyer retirée',
      'Votre bailleur a retiré sa proposition de nouveau loyer. Votre loyer ne change pas.', { amendment_id: avenant.id });
    return avenant;
  });
}

async function avenants(id, ownerId) {
  await chargerPourProprietaire(Lease, id, ownerId, { attributes: ['id', 'owner_id'] }, 'Bail');
  return LeaseAmendment.findAll({ where: { lease_id: id }, order: [['created_at', 'DESC']] });
}

// ── Congé ───────────────────────────────────────────────────────────────────

function verifierPreavis(lease, dateSortie) {
  const auPlusTot = ajouterMois(aujourdhui(), lease.notice_period_months || 0);
  if (dateSortie < auPlusTot) {
    throw new ValidationError('Données invalides', [
      `Le préavis du bail est de ${lease.notice_period_months} mois : date de sortie au plus tôt le ${formatFr(auPlusTot)}.`,
    ], 'PREAVIS_INSUFFISANT');
  }
  if (dateSortie <= lease.start_date) throw new ValidationError('Données invalides', ['La date de sortie doit suivre le début du bail.']);
}

async function enregistrerConge(t, lease, { auteur, dateSortie, motif }) {
  if (lease.status !== 'actif') throw new ConflictError('Seul un bail actif peut recevoir un congé.', 'TRANSITION_INVALIDE');
  if (lease.notice_given_at) throw new ConflictError('Un congé est déjà enregistré pour ce bail.', 'CONGE_DEJA_DONNE');
  verifierPreavis(lease, dateSortie);
  await lease.update({
    notice_given_at: new Date(), notice_given_by: auteur, notice_reason: motif || null, planned_exit_date: dateSortie, end_alerts_sent: [],
  }, { transaction: t });
  await journaliser({ action: 'bail.conge', entityType: 'lease', entityId: lease.id, ownerId: lease.owner_id, details: { auteur, date_sortie: dateSortie } }, t);
}

/** Congé donné par le propriétaire (motif obligatoire, préavis du bail respecté). */
async function congeProprietaire(id, ownerId, { planned_exit_date: dateSortie, reason }) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    await enregistrerConge(t, lease, { auteur: 'proprietaire', dateSortie, motif: reason });
    await prevenirLocataire(t, lease, await locataireDu(lease, t), 'Congé de votre bailleur',
      `Votre bailleur vous donne congé pour le ${formatFr(dateSortie)}. Motif : ${reason}`);
    return lease;
  });
}

async function annulerCongeDans(t, lease, auteur) {
  if (!lease.notice_given_at) throw new ConflictError('Aucun congé n’est enregistré pour ce bail.', 'CONGE_ABSENT');
  if (lease.notice_given_by !== auteur) {
    throw new ConflictError('Seule la partie qui a donné congé peut le retirer.', 'CONGE_AUTRE_PARTIE');
  }
  await lease.update({ notice_given_at: null, notice_given_by: null, notice_reason: null, planned_exit_date: null, end_alerts_sent: [] }, { transaction: t });
  await journaliser({ action: 'bail.annulation_conge', entityType: 'lease', entityId: lease.id, ownerId: lease.owner_id, details: { auteur } }, t);
}

async function annulerCongeProprietaire(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    await annulerCongeDans(t, lease, 'proprietaire');
    await prevenirLocataire(t, lease, await locataireDu(lease, t), 'Congé retiré', 'Votre bailleur a retiré son congé : le bail continue.');
    return lease;
  });
}

// ── Espace locataire ────────────────────────────────────────────────────────

const INCLUDE_PROPOSITION = [
  {
    model: Apartment, as: 'apartment', attributes: ['id', 'number', 'floor', 'type', 'surface', 'rooms_count', 'is_furnished'], paranoid: false,
    include: [{ model: Building, as: 'building', attributes: ['id', 'name', 'address', 'district', 'city', 'cover_document_id'], paranoid: false }],
  },
  { model: Owner, as: 'owner', attributes: ['id', 'display_name', 'company_name', 'phone'] },
];

const ATTRIBUTS_PROPOSITION = [
  'id', 'reference', 'status', 'lease_type', 'start_date', 'end_date', 'rent_amount', 'charges_amount', 'deposit_amount',
  'periodicity', 'due_day', 'occupants_count', 'special_conditions', 'rent_revision_rule', 'notice_period_months', 'proposed_at', 'tenant_id',
];

/** Ce qui attend la réponse du locataire : baux proposés et avenants. */
async function accords(tenantIds) {
  const [baux, propositions] = await Promise.all([
    Lease.findAll({
      where: {
        tenant_id: { [Op.in]: tenantIds }, status: 'brouillon', proposed_at: { [Op.ne]: null },
        tenant_accepted_at: null, tenant_refused_at: null,
      },
      attributes: ATTRIBUTS_PROPOSITION,
      include: INCLUDE_PROPOSITION,
      order: [['proposed_at', 'DESC']],
    }),
    LeaseAmendment.findAll({
      where: { tenant_id: { [Op.in]: tenantIds }, status: 'propose' },
      include: [{ model: Lease, as: 'lease', attributes: ['id', 'reference', 'status'], include: INCLUDE_PROPOSITION.slice(0, 1) }],
      order: [['created_at', 'DESC']],
    }),
  ]);
  const contrats = baux.length
    ? await LeaseDocument.findAll({ where: { lease_id: baux.map((b) => b.id) }, attributes: ['lease_id', 'document_id', 'version'], order: [['version', 'DESC']] })
    : [];
  return {
    leases: baux.map((b) => ({ ...b.toJSON(), contract_document_id: contrats.find((c) => c.lease_id === b.id)?.document_id || null })),
    amendments: propositions,
  };
}

async function bailDuLocataire(t, tenantIds, id) {
  return chargerPourLocataire(Lease, id, tenantIds, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
}

function exigerProposition(lease) {
  if (lease.status !== 'brouillon' || !lease.proposed_at) throw new ConflictError('Ce bail ne vous est pas proposé.', 'BAIL_NON_PROPOSE');
  if (lease.tenant_accepted_at || lease.tenant_refused_at) throw new ConflictError('Vous avez déjà répondu à ce bail.', 'DEJA_REPONDU');
}

async function accepterBail(user, tenantIds, id) {
  return sequelize.transaction(async (t) => {
    const lease = await bailDuLocataire(t, tenantIds, id);
    exigerProposition(lease);
    await lease.update({ tenant_accepted_at: new Date(), tenant_accepted_by: user.id, acceptance_method: 'application' }, { transaction: t });
    await journaliser({ action: 'bail.acceptation', entityType: 'lease', entityId: id, ownerId: lease.owner_id, details: { methode: 'application' } }, t);
    const tenant = await locataireDu(lease, t);
    await prevenirProprietaire(t, lease, 'Bail accepté', `${nomLocataire(tenant)} a accepté le bail ${lease.reference}. Vous pouvez l’activer.`);
    return lease;
  });
}

async function refuserBail(user, tenantIds, id, { reason }) {
  return sequelize.transaction(async (t) => {
    const lease = await bailDuLocataire(t, tenantIds, id);
    exigerProposition(lease);
    await lease.update({ tenant_refused_at: new Date(), refusal_reason: reason }, { transaction: t });
    await journaliser({ action: 'bail.refus', entityType: 'lease', entityId: id, ownerId: lease.owner_id, details: { motif: reason } }, t);
    const tenant = await locataireDu(lease, t);
    await prevenirProprietaire(t, lease, 'Bail refusé', `${nomLocataire(tenant)} a refusé le bail ${lease.reference} : ${reason.slice(0, 200)}`);
    return lease;
  });
}

async function avenantDuLocataire(t, tenantIds, amendmentId) {
  const repere = await LeaseAmendment.findByPk(amendmentId, { attributes: ['id', 'lease_id'], transaction: t });
  if (!repere) throw new NotFoundError('Avenant introuvable');
  // Même ordre de verrous que côté propriétaire : le bail, puis l'avenant.
  const lease = await bailDuLocataire(t, tenantIds, repere.lease_id);
  const avenant = await chargerAvenant(lease.id, amendmentId, t);
  exigerEnAttente(avenant);
  return { lease, avenant };
}

async function accepterAvenant(user, tenantIds, amendmentId) {
  return sequelize.transaction(async (t) => {
    const { lease, avenant } = await avenantDuLocataire(t, tenantIds, amendmentId);
    const r = await accepterDansTransaction(t, avenant, lease, { methode: 'application', userId: user.id });
    const tenant = await locataireDu(lease, t);
    await prevenirProprietaire(t, lease, 'Nouveau loyer accepté',
      `${nomLocataire(tenant)} accepte ${formatFcfa(avenant.rent_amount + avenant.charges_amount)} par mois à partir du ${formatFr(avenant.effective_from)}.`,
      { amendment_id: avenant.id });
    return r;
  });
}

async function refuserAvenant(user, tenantIds, amendmentId, { reason }) {
  return sequelize.transaction(async (t) => {
    const { lease, avenant } = await avenantDuLocataire(t, tenantIds, amendmentId);
    await avenant.update({ status: 'refuse', refusal_reason: reason, responded_at: new Date(), responded_by: user.id }, { transaction: t });
    await journaliser({ action: 'bail.refus_avenant', entityType: 'lease', entityId: lease.id, ownerId: lease.owner_id, details: { avenant: avenant.id, motif: reason } }, t);
    const tenant = await locataireDu(lease, t);
    await prevenirProprietaire(t, lease, 'Nouveau loyer refusé',
      `${nomLocataire(tenant)} refuse le nouveau loyer proposé : ${reason.slice(0, 200)}. Le loyer actuel reste en vigueur.`,
      { amendment_id: avenant.id });
    return avenant;
  });
}

async function congeLocataire(tenantIds, id, { planned_exit_date: dateSortie, reason }) {
  return sequelize.transaction(async (t) => {
    const lease = await bailDuLocataire(t, tenantIds, id);
    await enregistrerConge(t, lease, { auteur: 'locataire', dateSortie, motif: reason });
    const tenant = await locataireDu(lease, t);
    await prevenirProprietaire(t, lease, 'Congé du locataire',
      `${nomLocataire(tenant)} donne congé du bail ${lease.reference} pour le ${formatFr(dateSortie)}.`);
    return lease;
  });
}

async function annulerCongeLocataire(tenantIds, id) {
  return sequelize.transaction(async (t) => {
    const lease = await bailDuLocataire(t, tenantIds, id);
    await annulerCongeDans(t, lease, 'locataire');
    const tenant = await locataireDu(lease, t);
    await prevenirProprietaire(t, lease, 'Congé retiré', `${nomLocataire(tenant)} retire son congé du bail ${lease.reference}.`);
    return lease;
  });
}

// ── Alertes de fin de bail (tâche quotidienne) ──────────────────────────────

/** Rappels avant la date de sortie (jours) ; « depassee » une fois la date passée. */
const SEUILS_FIN = [60, 30, 7, 0];

/**
 * Alerte à envoyer pour une date de fin, ou null (fonction pure). Une seule
 * alerte par passage : la plus proche de la date, si elle n'a pas déjà été
 * envoyée pour CETTE date (une date déplacée relance le cycle).
 */
function alerteFin(date, jour, dejaEnvoyees) {
  const reste = ecartJours(jour, date);
  let seuil = null;
  if (reste < 0) seuil = 'depassee';
  else {
    const atteints = SEUILS_FIN.filter((s) => reste <= s);
    if (atteints.length) seuil = String(Math.min(...atteints));
  }
  if (seuil === null) return null;
  const cle = `${date}:${seuil}`;
  return dejaEnvoyees.includes(cle) ? null : { cle, seuil, reste };
}

async function alertesFinDeBail(jour = aujourdhui()) {
  const limite = ajouterJours(jour, SEUILS_FIN[0]);
  const baux = await Lease.findAll({
    where: {
      status: 'actif',
      [Op.or]: [{ planned_exit_date: { [Op.lte]: limite } }, { planned_exit_date: null, end_date: { [Op.lte]: limite } }],
    },
    attributes: ['id', 'owner_id', 'tenant_id', 'reference', 'end_date', 'planned_exit_date', 'notice_given_by', 'end_alerts_sent'],
  });
  let envoyees = 0;
  for (const b of baux) {
    const date = b.planned_exit_date || b.end_date;
    const alerte = alerteFin(date, jour, b.end_alerts_sent || []);
    if (!alerte) continue;
    try {
      await sequelize.transaction(async (t) => {
        const lease = await Lease.findByPk(b.id, { transaction: t, lock: t.LOCK.UPDATE });
        if (lease.status !== 'actif' || (lease.end_alerts_sent || []).includes(alerte.cle)) return;
        const conge = Boolean(lease.planned_exit_date);
        const quoi = conge ? 'La sortie prévue' : 'La fin du bail';
        if (alerte.seuil === 'depassee') {
          await prevenirProprietaire(t, lease, 'Date de sortie dépassée',
            `${quoi} (bail ${lease.reference}) était le ${formatFr(date)}. Enregistrez la fin du bail le jour du départ, ou prolongez-le.`);
        } else {
          const quand = alerte.reste === 0 ? 'aujourd’hui' : `dans ${alerte.reste} jours, le ${formatFr(date)}`;
          await prevenirProprietaire(t, lease, 'Fin de bail proche',
            `${quoi} du bail ${lease.reference} est ${quand}. Préparez l’état des lieux de sortie et le décompte de caution.`);
          await prevenirLocataire(t, lease, await locataireDu(lease, t), 'Fin de bail proche',
            `${quoi} de votre location est ${quand}.`);
        }
        await lease.update({ end_alerts_sent: [...(lease.end_alerts_sent || []), alerte.cle] }, { transaction: t });
        envoyees += 1;
      });
    } catch (err) {
      logger.error('[bail] Alerte de fin de bail impossible', { lease_id: b.id, error: err.message });
    }
  }
  return envoyees;
}

module.exports = {
  proposer, acceptationPapier, accordAEffacer, ACCORD_EFFACE,
  proposerAvenant, avenantPapier, annulerAvenant, avenants,
  congeProprietaire, annulerCongeProprietaire,
  accords, accepterBail, refuserBail, accepterAvenant, refuserAvenant, congeLocataire, annulerCongeLocataire,
  alerteFin, alertesFinDeBail,
};
