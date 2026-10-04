'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  RentPayment, PaymentAllocation, PaymentTransaction, PaymentProvider, Lease, Tenant, Apartment, Building,
  RentSchedule, Charge, Receipt, ReconciliationEntry, Document,
} = require('../../../models/index.js');
const { chargerPourProprietaire, verifierReference } = require('../../../utils/acces.js');
const { ordre, periode } = require('../../../utils/liste.js');
const { aujourdhui } = require('../../../utils/dates.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { ConflictError, ValidationError } = require('../../../errors/AppError.js');
const allocation = require('./allocation.service.js');
const rapprochement = require('./rapprochement.service.js');
const paydunya = require('../../../infrastructure/paiement/paydunya.provider.js');
const caisse = require('../../caisse/service/caisse.service.js');
const documents = require('../../document/service/document.service.js');
const { notifier, destinataireLocataire } = require('../../notification/service/notification.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');

/**
 * Paiements côté propriétaire (§ 12, § 51) : encaissements manuels (espèces,
 * virement, chèque…), validation des preuves de paiement direct, remboursement,
 * consultation, configuration des moyens de paiement.
 */

const INCLUDE_PAIEMENT = [
  { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone'], paranoid: false },
  { model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false, include: [{ model: Building, as: 'building', attributes: ['id', 'name'], paranoid: false }] },
];

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['lease_id', 'tenant_id', 'apartment_id', 'method', 'status']) if (f[cle]) where[cle] = f[cle];
  const p = periode(f.du, f.au);
  if (p) where.paid_on = p;
  const include = INCLUDE_PAIEMENT.map((i) => ({ ...i }));
  if (f.building_id) include[1] = { ...include[1], required: true, where: { building_id: f.building_id } };
  return RentPayment.findAndCountAll({ where, include, order: ordre(f.tri, '-paid_on'), limit, offset });
}

async function detail(id, ownerId) {
  return chargerPourProprietaire(RentPayment, id, ownerId, {
    include: [
      ...INCLUDE_PAIEMENT,
      {
        model: PaymentAllocation, as: 'allocations', attributes: ['id', 'amount', 'reversed_at', 'created_at'],
        include: [
          { model: RentSchedule, as: 'schedule', attributes: ['id', 'label', 'due_date', 'amount_due', 'amount_paid', 'status'] },
          { model: Charge, as: 'charge', attributes: ['id', 'label', 'amount', 'amount_paid', 'status'] },
        ],
      },
      { model: PaymentTransaction, as: 'transaction', attributes: ['id', 'reference', 'provider', 'wallet', 'mode', 'status', 'provider_transaction_id', 'confirmed_at'] },
    ],
  }, 'Paiement');
}

/**
 * Encaissement saisi par le propriétaire (§ 12 « paiement en espèces » :
 * montant, date, locataire, appartement, mode, référence, commentaire — le
 * système garde une trace complète). Le bail désigne locataire et appartement.
 */
async function encaisser(ownerId, user, donnees) {
  return sequelize.transaction(async (t) => {
    const lease = await verifierReference(Lease, donnees.lease_id, ownerId, 'Bail', { transaction: t, lock: t.LOCK.UPDATE });
    if (!['actif', 'termine'].includes(lease.status)) {
      throw new ConflictError('Un paiement ne s’enregistre que sur un bail actif ou terminé (solde de sortie).', 'BAIL_INVALIDE');
    }
    const cible = donnees.rent_schedule_id ? { rent_schedule_id: donnees.rent_schedule_id } : (donnees.charge_id ? { charge_id: donnees.charge_id } : null);
    const r = await allocation.enregistrerPaiement(t, {
      lease,
      montant: donnees.amount,
      methode: donnees.method,
      datePaiement: donnees.paid_on,
      enregistrePar: user.id,
      reference: donnees.reference || null,
      commentaire: donnees.comment || null,
      cible,
      excedent: 'fifo',
    });
    return { payment: r.paiement, allocations: r.allocations, receipts: r.quittances };
  });
}

/**
 * Remboursement (§ 40, § 51.4) : le paiement passe « remboursé », ses
 * imputations sont annulées (échéances rouvertes, quittances annulées), la
 * sortie d'argent est inscrite en caisse, la transaction liée passe
 * « remboursée ».
 */
async function rembourser(ownerId, user, id, { reason, method }) {
  return sequelize.transaction(async (t) => {
    const paiement = await chargerPourProprietaire(RentPayment, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Paiement');
    if (paiement.status !== 'valide') throw new ConflictError('Ce paiement est déjà remboursé', 'DEJA_REMBOURSE');

    // Excédent DÉJÀ rendu au payeur (entrée « excedent » rejetée = sortie de
    // caisse inscrite à ce moment-là) : il ne sort pas une seconde fois. La
    // caisse rend exactement ce qui reste du paiement (§ 21 : sorties ≤ entrées).
    // Le verrou du paiement (pris ci-dessus, et aussi par le rejet d'un
    // excédent) sérialise les deux opérations.
    const dejaRendu = Number(await ReconciliationEntry.sum('amount', {
      where: { rent_payment_id: id, type: 'excedent', status: 'rejete' },
      transaction: t,
    }) || 0);
    const aRendre = paiement.amount - dejaRendu;

    const allocations = await allocation.desimputer(t, paiement, `Remboursement du paiement ${paiement.reference}`);
    await paiement.update({ status: 'rembourse', refunded_at: new Date(), refund_reason: reason, refunded_by: user.id }, { transaction: t });

    // Un excédent encore en attente de décision n'a plus d'objet.
    await ReconciliationEntry.update(
      { status: 'rejete', resolved_by: user.id, resolved_at: new Date(), resolution_note: 'Paiement remboursé' },
      { where: { rent_payment_id: id, status: 'en_attente' }, transaction: t }
    );
    if (paiement.transaction_id) {
      await PaymentTransaction.update({ status: 'remboursee', refunded_at: new Date() }, { where: { id: paiement.transaction_id }, transaction: t });
    }

    if (aRendre > 0) {
      const apartment = await Apartment.findByPk(paiement.apartment_id, { transaction: t, paranoid: false, attributes: ['id', 'building_id'] });
      await caisse.enregistrerMouvement(t, {
        ownerId, buildingId: apartment.building_id, apartmentId: apartment.id, direction: 'sortie', category: 'remboursement',
        amount: aRendre, method: method || paiement.method, occurredOn: aujourdhui(),
        label: `Remboursement du paiement ${paiement.reference}`, sourceType: 'rent_payment', sourceId: paiement.id, createdBy: user.id,
      });
    }

    await journaliser({
      action: 'paiement.remboursement', entityType: 'rent_payment', entityId: id, ownerId,
      details: {
        reference: paiement.reference, montant: paiement.amount, montant_rendu: aRendre, excedent_deja_rendu: dejaRendu,
        motif: reason, imputations_annulees: allocations.length,
      },
    }, t);
    const tenant = await Tenant.findByPk(paiement.tenant_id, { transaction: t, paranoid: false });
    await notifier(t, {
      destinataires: [destinataireLocataire(tenant)], ownerId, type: 'nouveau_paiement',
      titre: 'Paiement remboursé', corps: `Votre paiement ${paiement.reference} de ${formatFcfa(paiement.amount)} a été remboursé${dejaRendu ? ` (dont ${formatFcfa(dejaRendu)} d’excédent déjà rendu)` : ''}.`,
      donnees: { rent_payment_id: id },
    });
    return paiement;
  });
}

// ── Transactions numériques ─────────────────────────────────────────────────

async function listerTransactions(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['status', 'mode', 'provider', 'tenant_id', 'lease_id']) if (f[cle]) where[cle] = f[cle];
  return PaymentTransaction.findAndCountAll({
    where,
    attributes: { exclude: ['raw_payload', 'provider_token'] },
    include: [
      { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone'], paranoid: false },
      { model: RentSchedule, as: 'schedule', attributes: ['id', 'label', 'due_date', 'amount_due', 'amount_paid'] },
    ],
    order: ordre(f.tri, '-created_at'),
    limit,
    offset,
  });
}

async function detailTransaction(id, ownerId) {
  const tx = await chargerPourProprietaire(PaymentTransaction, id, ownerId, {
    attributes: { exclude: ['raw_payload', 'provider_token'] },
    include: [
      { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone'], paranoid: false },
      { model: RentSchedule, as: 'schedule', attributes: ['id', 'label', 'due_date', 'amount_due', 'amount_paid', 'status'] },
      { model: RentPayment, as: 'payment', attributes: ['id', 'reference', 'amount', 'status'] },
    ],
  }, 'Transaction');
  const preuve = tx.proof_document_id ? await Document.findByPk(tx.proof_document_id) : null;
  return { ...tx.toJSON(), proof: preuve ? documents.versApi(preuve) : null };
}

/**
 * Validation « en un clic » d'une preuve de paiement direct (§ 51.2 mode B) :
 * le paiement est enregistré et imputé exactement comme une confirmation de
 * fournisseur (même moteur, mêmes règles d'excédent).
 */
async function validerPreuve(ownerId, user, id) {
  return sequelize.transaction(async (t) => {
    const tx = await chargerPourProprietaire(PaymentTransaction, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Transaction');
    if (tx.mode !== 'preuve') throw new ConflictError('Seule une preuve de paiement direct se valide à la main.', 'MODE_INVALIDE');
    if (tx.status !== 'en_attente') throw new ConflictError(`Transaction déjà traitée (« ${tx.status} »).`, 'DEJA_TRAITEE');
    const r = await rapprochement.confirmer(t, tx, { montant: tx.amount, validePar: user.id });
    await journaliser({ action: 'paiement.validation_preuve', entityType: 'payment_transaction', entityId: id, ownerId, details: { reference: tx.reference, montant: tx.amount } }, t);
    return { transaction: tx, payment: r.paiement, receipts: r.quittances };
  });
}

/** Refus d'une preuve (§ 56.2 « preuve refusée par le propriétaire »). */
async function rejeterPreuve(ownerId, user, id, { reason }) {
  return sequelize.transaction(async (t) => {
    const tx = await chargerPourProprietaire(PaymentTransaction, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Transaction');
    if (tx.mode !== 'preuve') throw new ConflictError('Seule une preuve de paiement direct se refuse à la main.', 'MODE_INVALIDE');
    if (tx.status !== 'en_attente') throw new ConflictError(`Transaction déjà traitée (« ${tx.status} »).`, 'DEJA_TRAITEE');
    await tx.update({ status: 'echouee', failed_at: new Date(), rejection_reason: reason, validated_by: user.id, validated_at: new Date() }, { transaction: t });
    await journaliser({ action: 'paiement.rejet_preuve', entityType: 'payment_transaction', entityId: id, ownerId, details: { reference: tx.reference, motif: reason } }, t);
    const tenant = await Tenant.findByPk(tx.tenant_id, { transaction: t, paranoid: false });
    await notifier(t, {
      destinataires: [destinataireLocataire(tenant)], ownerId, type: 'nouveau_paiement',
      titre: 'Preuve de paiement refusée', corps: `Votre preuve de paiement de ${formatFcfa(tx.amount)} a été refusée : ${reason}`,
      donnees: { payment_transaction_id: id },
    });
    return tx;
  });
}

// ── Moyens de paiement du propriétaire (§ 51.5) ─────────────────────────────

function urlWebhook(provider) {
  const base = (process.env.API_PUBLIC_URL || '').replace(/\/$/, '');
  return provider.mode === 'integre' ? `${base}/api/v1/webhooks/${provider.provider}/${provider.id}` : null;
}

async function moyens(ownerId) {
  const liste = await PaymentProvider.findAll({ where: { owner_id: ownerId }, order: [['provider', 'ASC'], ['mode', 'ASC']] });
  return liste.map((p) => ({ ...p.toJSON(), webhook_url: urlWebhook(p) }));
}

/**
 * Configure (ou met à jour) un moyen de paiement. Les identifiants d'API sont
 * chiffrés au repos et ne sont jamais relus par l'API.
 */
async function configurerMoyen(ownerId, { provider, mode, label, account_number: numero, credentials, is_active: actif }) {
  if (mode === 'integre' && provider === 'orange_money') {
    throw new ValidationError('Données invalides', ["Orange Money s'intègre via PayDunya (fournisseur « paydunya »)"]);
  }
  if (mode === 'preuve' && provider === 'paydunya') {
    throw new ValidationError('Données invalides', ['Le paiement direct avec preuve se configure pour « wave » ou « orange_money »']);
  }
  return sequelize.transaction(async (t) => {
    let moyen = await PaymentProvider.findOne({ where: { owner_id: ownerId, provider, mode }, transaction: t, lock: t.LOCK.UPDATE });
    const valeurs = {
      label: label ?? moyen?.label ?? null,
      account_number: numero ?? moyen?.account_number ?? null,
      is_active: actif ?? true,
    };
    if (credentials) valeurs.credentials = credentials;
    // Moyen PayDunya ACTIF sans clés PayDunya complètes (ancien moyen PayTech
    // converti par la migration 008, dont les clés sont inutilisables) : les
    // nouvelles clés doivent être saisies avant toute réactivation.
    const cles = valeurs.credentials ?? moyen?.credentials;
    // Production : un moyen PayDunya ACTIF doit être en mode « live » (constat
    // M11) — des clés de test confirmeraient des loyers sans argent réel.
    if (provider === 'paydunya' && mode === 'integre' && valeurs.is_active && cles && cles.mode !== 'live' && paydunya.modeTestInterdit()) {
      throw new ValidationError('Données invalides', ['Mode « test » PayDunya interdit en production : saisissez les clés de production (mode « live »).'], 'MODE_TEST_INTERDIT');
    }
    if (provider === 'paydunya' && mode === 'integre' && valeurs.is_active && moyen && !(cles?.master_key && cles?.private_key && cles?.token)) {
      throw new ValidationError('Données invalides', ['Saisissez les clés de votre application PayDunya (master_key, private_key, token)'], 'IDENTIFIANTS_REQUIS');
    }
    if (!moyen) {
      if (mode === 'integre' && !credentials) throw new ValidationError('Données invalides', ['Les identifiants du fournisseur sont obligatoires']);
      if (mode === 'preuve' && !numero) throw new ValidationError('Données invalides', ['Le numéro de réception est obligatoire']);
      moyen = await PaymentProvider.create({ owner_id: ownerId, provider, mode, ...valeurs }, { transaction: t });
    } else {
      await moyen.update(valeurs, { transaction: t });
    }
    await journaliser({
      action: 'paiement.configuration_moyen', entityType: 'payment_provider', entityId: moyen.id, ownerId,
      details: { provider, mode, actif: moyen.is_active, identifiants_modifies: Boolean(credentials) },
    }, t);
    return { ...moyen.toJSON(), webhook_url: urlWebhook(moyen) };
  });
}

/** Quittances d'un paiement (lien paiement → échéances soldées). */
async function quittancesDuPaiement(id, ownerId) {
  await chargerPourProprietaire(RentPayment, id, ownerId, { attributes: ['id', 'owner_id'] }, 'Paiement');
  const allocs = await PaymentAllocation.findAll({ where: { rent_payment_id: id, rent_schedule_id: { [Op.ne]: null } }, attributes: ['rent_schedule_id'] });
  return Receipt.findAll({ where: { rent_schedule_id: allocs.map((a) => a.rent_schedule_id), cancelled_at: null } });
}

module.exports = {
  lister, detail, encaisser, rembourser, listerTransactions, detailTransaction, validerPreuve, rejeterPreuve,
  moyens, configurerMoyen, quittancesDuPaiement,
};
