'use strict';

const { Op } = require('sequelize');
const {
  RentPayment, PaymentAllocation, RentSchedule, Charge, ReconciliationEntry, Tenant, Lease,
} = require('../../../models/index.js');
const { prochainNumero, pad } = require('../../../utils/compteur.js');
const { aujourdhui, compacte } = require('../../../utils/dates.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { ValidationError, ConflictError } = require('../../../errors/AppError.js');
const echeances = require('../../loyer/service/echeance.service.js');
const parametres = require('../../parametres/service/parametres.service.js');
const caisse = require('../../caisse/service/caisse.service.js');
const quittances = require('../../quittance/service/quittance.service.js');
const { notifier, destinataireLocataire, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');

/**
 * Moteur d'imputation des paiements — SEUL chemin qui modifie
 * `rent_schedules.amount_paid` et `charges.amount_paid`.
 *
 * § 41 « un loyer ne peut être marqué PAYÉ que lorsqu'un paiement valide
 * existe » : le statut `paye` découle toujours d'allocations de paiements
 * valides (et la base refuse `paye` sans montant soldé).
 *
 * § 51.3, pour un paiement ciblé (mobile money) :
 *   - montant exact     → échéance PAYÉE + quittance ;
 *   - montant inférieur → PARTIELLEMENT PAYÉE, le solde reste dû ;
 *   - montant supérieur → l'excédent est mis en attente (file de
 *     rapprochement, type « excedent ») et n'est imputé à l'échéance suivante
 *     qu'APRÈS confirmation du propriétaire.
 * Pour un encaissement saisi par le propriétaire lui-même (espèces, virement),
 * l'excédent est imputé directement aux échéances suivantes (il vient de le
 * décider) ; au-delà de tout le dû généré, la saisie est refusée.
 */

// Statut d'une charge refacturée : définition unique dans le module charge.
const { statutCharge } = require('../../charge/service/repartition.calcul.js');

const resteEcheance = (e) => e.amount_due - e.amount_paid;
const resteCharge = (c) => c.amount - c.amount_paid;

/** Charges ouvertes d'un bail, plus anciennes d'abord (verrouillées). */
async function chargesOuvertes(leaseId, t) {
  return Charge.findAll({
    where: { lease_id: leaseId, status: { [Op.in]: ['a_payer', 'partiellement_paye', 'en_retard'] } },
    order: [['due_date', 'ASC'], ['created_at', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
}

/**
 * Impute `montant` sur une liste ordonnée de cibles et met à jour leurs soldes
 * et statuts. Retourne { allocations, reste, echeancesSoldees }.
 */
async function imputer(t, rentPayment, cibles, montant, reglages) {
  const jour = aujourdhui();
  let reste = montant;
  const allocations = [];
  const echeancesSoldees = [];
  for (const cible of cibles) {
    if (reste <= 0) break;
    const estEcheance = cible instanceof RentSchedule;
    const du = estEcheance ? resteEcheance(cible) : resteCharge(cible);
    if (du <= 0) continue;
    const part = Math.min(du, reste);
    reste -= part;
    allocations.push(await PaymentAllocation.create({
      owner_id: rentPayment.owner_id,
      rent_payment_id: rentPayment.id,
      rent_schedule_id: estEcheance ? cible.id : null,
      charge_id: estEcheance ? null : cible.id,
      amount: part,
    }, { transaction: t }));

    const paye = cible.amount_paid + part;
    if (estEcheance) {
      const statut = echeances.statutA({ ...cible.toJSON(), amount_paid: paye }, jour, reglages);
      await cible.update({ amount_paid: paye, status: statut, paid_at: statut === 'paye' ? new Date() : cible.paid_at }, { transaction: t });
      if (statut === 'paye') echeancesSoldees.push(cible);
    } else {
      const statut = statutCharge({ ...cible.toJSON(), amount_paid: paye }, jour, reglages.late_grace_days);
      await cible.update({ amount_paid: paye, status: statut, paid_at: statut === 'paye' ? new Date() : cible.paid_at }, { transaction: t });
    }
  }
  return { allocations, reste, echeancesSoldees };
}

/** Références de tous les paiements valides d'une échéance (pour la quittance). */
async function referencesDe(t, scheduleId) {
  const allocs = await PaymentAllocation.findAll({
    where: { rent_schedule_id: scheduleId, reversed_at: null },
    include: [{ model: RentPayment, as: 'payment', attributes: ['reference'] }],
    transaction: t,
  });
  return [...new Set(allocs.map((a) => a.payment.reference))];
}

/** Référence lisible d'un paiement : PAY-AAAAMMJJ-NNN (§ 13), unique par propriétaire. */
async function referencePaiement(t, ownerId, jour) {
  const n = await prochainNumero(`owner:${ownerId}:payment:${compacte(jour)}`, t);
  return `PAY-${compacte(jour)}-${pad(n, 3)}`;
}

/**
 * Enregistre un paiement VALIDE et l'impute.
 *
 * @param {import('sequelize').Transaction} t
 * @param {object} p
 * @param {object} p.lease                bail (déjà contrôlé pour l'appelant)
 * @param {number} p.montant
 * @param {string} p.methode              MODE_PAIEMENT
 * @param {string} p.datePaiement         AAAA-MM-JJ
 * @param {string} p.enregistrePar        utilisateur (propriétaire, locataire ou système)
 * @param {string|null} [p.reference]
 * @param {string|null} [p.commentaire]
 * @param {string|null} [p.transactionId]
 * @param {{ rent_schedule_id?: string, charge_id?: string }|null} [p.cible]
 * @param {'fifo'|'confirmation'} p.excedent  traitement d'un montant supérieur au dû ciblé
 * @param {object|null} [p.acteur]        auteur pour l'audit (défaut : utilisateur de la requête)
 */
async function enregistrerPaiement(t, {
  lease, montant, methode, datePaiement, enregistrePar, reference = null, commentaire = null,
  transactionId = null, cible = null, excedent = 'fifo', acteur = null,
}) {
  const ownerId = lease.owner_id;
  const reglages = await parametres.proprietaire(ownerId, t);

  let ref = reference;
  if (ref) {
    if (await RentPayment.count({ where: { owner_id: ownerId, reference: ref }, transaction: t })) {
      throw new ConflictError('Cette référence de paiement existe déjà', 'REFERENCE_EXISTANTE');
    }
  } else {
    ref = await referencePaiement(t, ownerId, datePaiement);
  }

  const paiement = await RentPayment.create({
    owner_id: ownerId,
    tenant_id: lease.tenant_id,
    lease_id: lease.id,
    apartment_id: lease.apartment_id,
    transaction_id: transactionId,
    amount: montant,
    method: methode,
    paid_on: datePaiement,
    reference: ref,
    comment: commentaire,
    status: 'valide',
    recorded_by: enregistrePar,
  }, { transaction: t });

  // Cibles : d'abord l'échéance ou la charge visée, puis (selon la stratégie)
  // les autres postes ouverts du bail, du plus ancien au plus récent.
  let cibles = [];
  if (cible?.rent_schedule_id) {
    const e = await RentSchedule.findByPk(cible.rent_schedule_id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!e || e.lease_id !== lease.id) throw new ValidationError('Données invalides', ["L'échéance ne correspond pas à ce bail"]);
    if (e.status === 'annule') throw new ConflictError('Cette échéance est annulée', 'ECHEANCE_ANNULEE');
    cibles.push(e);
  } else if (cible?.charge_id) {
    const c = await Charge.findByPk(cible.charge_id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!c || c.lease_id !== lease.id) throw new ValidationError('Données invalides', ['La charge ne correspond pas à ce bail']);
    if (c.status === 'annule') throw new ConflictError('Cette charge est annulée', 'CHARGE_ANNULEE');
    cibles.push(c);
  }

  let resultat = await imputer(t, paiement, cibles, montant, reglages);

  if (resultat.reste > 0 && (excedent === 'fifo' || !cibles.length)) {
    const dejaVises = new Set(cibles.map((c) => c.id));
    const [ech, ch] = await Promise.all([echeances.ouvertesDuBail(lease.id, t), chargesOuvertes(lease.id, t)]);
    cibles = [...ech, ...ch]
      .filter((c) => !dejaVises.has(c.id))
      .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
    const suite = await imputer(t, paiement, cibles, resultat.reste, reglages);
    resultat = {
      allocations: [...resultat.allocations, ...suite.allocations],
      reste: suite.reste,
      echeancesSoldees: [...resultat.echeancesSoldees, ...suite.echeancesSoldees],
    };
    if (resultat.reste > 0 && excedent === 'fifo') {
      throw new ValidationError(
        'Montant supérieur au total dû sur ce bail',
        [`Excédent de ${formatFcfa(resultat.reste)} : aucune échéance ouverte à laquelle l’imputer.`],
        'MONTANT_SUPERIEUR_AU_DU'
      );
    }
  }

  // Excédent d'un paiement ciblé (§ 51.3) : en attente de confirmation.
  let entreeExcedent = null;
  if (resultat.reste > 0) {
    entreeExcedent = await ReconciliationEntry.create({
      owner_id: ownerId,
      type: 'excedent',
      status: 'en_attente',
      amount: resultat.reste,
      transaction_id: transactionId,
      rent_payment_id: paiement.id,
      lease_id: lease.id,
      tenant_id: lease.tenant_id,
      details: { reference_paiement: ref },
    }, { transaction: t });
  }

  // Caisse (§ 21) : la part imputée à des charges en « Charges », le reste en « Loyers ».
  const partCharges = resultat.allocations.filter((a) => a.charge_id).reduce((s, a) => s + a.amount, 0);
  const apartment = await lease.getApartment({ transaction: t, paranoid: false, attributes: ['id', 'building_id', 'number'] });
  const base = {
    ownerId, buildingId: apartment.building_id, apartmentId: apartment.id, direction: 'entree', method: methode,
    occurredOn: datePaiement, sourceType: 'rent_payment', sourceId: paiement.id, createdBy: enregistrePar,
  };
  if (montant - partCharges > 0) await caisse.enregistrerMouvement(t, { ...base, category: 'loyer', amount: montant - partCharges, label: `Loyer — ${ref} — appartement ${apartment.number}` });
  if (partCharges > 0) await caisse.enregistrerMouvement(t, { ...base, category: 'charges', amount: partCharges, label: `Charges — ${ref} — appartement ${apartment.number}` });

  // Quittances des échéances soldées (§ 13, § 44).
  const recus = [];
  for (const e of resultat.echeancesSoldees) {
    recus.push(await quittances.genererPourEcheance(t, e, await referencesDe(t, e.id)));
  }

  await journaliser({
    action: 'paiement.paiement', entityType: 'rent_payment', entityId: paiement.id, ownerId,
    acteur,
    details: {
      reference: ref, montant, methode, lease_id: lease.id, transaction_id: transactionId,
      allocations: resultat.allocations.map((a) => ({ echeance: a.rent_schedule_id, charge: a.charge_id, montant: a.amount })),
      excedent_en_attente: entreeExcedent ? entreeExcedent.amount : 0,
      quittances: recus.map((r) => r.number),
    },
  }, t);

  // Notifications (§ 27 « nouveau paiement », § 54.2 « paiement confirmé »).
  const tenant = await Tenant.findByPk(lease.tenant_id, { transaction: t, paranoid: false });
  const libelles = resultat.allocations.length
    ? (await RentSchedule.findAll({ where: { id: resultat.allocations.map((a) => a.rent_schedule_id).filter(Boolean) }, attributes: ['label'], transaction: t })).map((e) => e.label)
    : [];
  const periodeTexte = libelles.join(', ') || 'votre location';
  await notifier(t, {
    destinataires: [destinataireLocataire(tenant)],
    ownerId,
    type: 'nouveau_paiement',
    titre: 'Paiement confirmé',
    corps: `Paiement de ${formatFcfa(montant)} reçu (${ref}) pour ${periodeTexte}.${recus.length ? ' Votre quittance est disponible.' : ''}`,
    donnees: { rent_payment_id: paiement.id, receipt_ids: recus.map((r) => r.id).join(',') },
    whatsapp: { evenement: 'paiement_confirme', parametres: [formatFcfa(montant), periodeTexte, ref] },
  });
  const proprietaires = (await destinatairesProprietaire(ownerId, t)).filter((d) => d.userId !== enregistrePar);
  if (proprietaires.length || entreeExcedent) {
    await notifier(t, {
      destinataires: entreeExcedent ? await destinatairesProprietaire(ownerId, t) : proprietaires,
      ownerId,
      type: entreeExcedent ? 'rapprochement' : 'nouveau_paiement',
      titre: entreeExcedent ? 'Excédent de paiement à confirmer' : 'Nouveau paiement',
      corps: entreeExcedent
        ? `${tenant.first_name} ${tenant.last_name} a payé ${formatFcfa(montant)} : excédent de ${formatFcfa(entreeExcedent.amount)} à imputer ou rembourser.`
        : `${tenant.first_name} ${tenant.last_name} : ${formatFcfa(montant)} reçu (${ref}).`,
      donnees: { rent_payment_id: paiement.id, reconciliation_entry_id: entreeExcedent?.id || '' },
    });
  }

  return { paiement, allocations: resultat.allocations, quittances: recus, excedent: entreeExcedent };
}

/**
 * Impute un crédit en attente (excédent confirmé par le propriétaire) sur les
 * postes ouverts du bail — « crédit sur l'échéance suivante » (§ 51.3).
 */
async function imputerCredit(t, entree) {
  const paiement = await RentPayment.findByPk(entree.rent_payment_id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!paiement || paiement.status !== 'valide') throw new ConflictError('Le paiement d’origine n’est plus valide', 'PAIEMENT_INVALIDE');
  const lease = await Lease.findByPk(paiement.lease_id, { transaction: t });
  const reglages = await parametres.proprietaire(lease.owner_id, t);
  const [ech, ch] = await Promise.all([echeances.ouvertesDuBail(lease.id, t), chargesOuvertes(lease.id, t)]);
  const cibles = [...ech, ...ch].sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
  const resultat = await imputer(t, paiement, cibles, entree.amount, reglages);
  if (resultat.reste > 0) {
    throw new ConflictError(`Aucune échéance ouverte ne peut absorber ${formatFcfa(resultat.reste)} : remboursez l’excédent.`, 'CREDIT_NON_IMPUTABLE');
  }
  const recus = [];
  for (const e of resultat.echeancesSoldees) recus.push(await quittances.genererPourEcheance(t, e, await referencesDe(t, e.id)));
  return { allocations: resultat.allocations, quittances: recus };
}

/**
 * Annule les imputations d'un paiement remboursé : soldes rouverts, statuts
 * recalculés, quittances annulées (§ 51.4 « l'échéance est rouverte »).
 */
async function desimputer(t, paiement, motif) {
  const reglages = await parametres.proprietaire(paiement.owner_id, t);
  const jour = aujourdhui();
  const allocations = await PaymentAllocation.findAll({ where: { rent_payment_id: paiement.id, reversed_at: null }, transaction: t, lock: t.LOCK.UPDATE });
  for (const a of allocations) {
    await a.update({ reversed_at: new Date() }, { transaction: t });
    if (a.rent_schedule_id) {
      const e = await RentSchedule.findByPk(a.rent_schedule_id, { transaction: t, lock: t.LOCK.UPDATE });
      const paye = e.amount_paid - a.amount;
      const statut = echeances.statutA({ ...e.toJSON(), amount_paid: paye }, jour, reglages);
      await e.update({ amount_paid: paye, status: statut, paid_at: statut === 'paye' ? e.paid_at : null }, { transaction: t });
      await quittances.annulerPourEcheance(t, e.id, motif);
    } else {
      const c = await Charge.findByPk(a.charge_id, { transaction: t, lock: t.LOCK.UPDATE });
      const paye = c.amount_paid - a.amount;
      const statut = statutCharge({ ...c.toJSON(), amount_paid: paye }, jour, reglages.late_grace_days);
      await c.update({ amount_paid: paye, status: statut, paid_at: statut === 'paye' ? c.paid_at : null }, { transaction: t });
    }
  }
  return allocations;
}

module.exports = { enregistrerPaiement, imputerCredit, desimputer, statutCharge, referencePaiement };
