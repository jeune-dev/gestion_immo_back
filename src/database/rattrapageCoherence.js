'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const {
  ChargeInvoice, Expense, Deposit, DepositTransaction, Lease, Apartment,
} = require('../models/index.js');
const { creerDepenseFacture } = require('../modules/charge/service/factureCommune.service.js');
const { montantRetenu, sortieDeRetenue, imputerRetenue } = require('../modules/caution/service/caution.service.js');
const { journaliser } = require('../modules/audit/service/audit.service.js');

/**
 * Reprise des données saisies avant les règles de cohérence financière :
 *   - facture répartie sans dépense : dépense datée de sa répartition, ou
 *     rattachement de l'unique dépense manuelle qui lui correspond ;
 *   - retenue de caution sans sortie de caisse : sortie à la date de la retenue ;
 *   - retenue pour impayés non imputée : imputée seulement sur demande, car elle
 *     solde des postes et prévient le locataire.
 *
 * Tout reste signalé sans être modifié quand seul le propriétaire peut trancher :
 * factures en double, dépense manuelle ambiguë, provision non déduite.
 *
 * Rejouable : ce qui est déjà repris ne ressort plus de l'analyse.
 */

const requete = (sql, replacements = {}, t = null) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction: t });

const filtre = (alias, ownerId) => (ownerId ? `AND ${alias}.owner_id = CAST(:ownerId AS uuid)` : '');

/** Mêmes critères que `refuserDoublon` à la saisie. */
const facturesEnDouble = (ownerId) => requete(`
  SELECT ci.owner_id, ci.amount, ci.period_start, ci.period_end, array_agg(ci.id ORDER BY ci.created_at) AS ids
    FROM charge_invoices ci
   WHERE ci.status <> 'annulee' ${filtre('ci', ownerId)}
   GROUP BY ci.owner_id, ci.building_id, ci.charge_type, ci.period_start, ci.period_end, ci.amount, lower(COALESCE(ci.supplier, ''))
  HAVING count(*) > 1 AND count(DISTINCT ci.invoice_number) <= 1`, { ownerId });

/** Une dépense annulée à la main compte comme traitée : elle n'est pas recréée. */
const facturesSansDepense = (ownerId) => requete(`
  SELECT ci.id, ci.owner_id, ci.amount, CAST(COALESCE(ci.allocated_at, ci.updated_at) AS date)::text AS date_repartition,
         ARRAY(SELECT e.id FROM expenses e
                WHERE e.owner_id = ci.owner_id AND e.building_id = ci.building_id AND e.amount = ci.amount
                  AND e.status = 'valide' AND e.charge_invoice_id IS NULL AND e.work_order_id IS NULL
                  AND e.spent_on BETWEEN ci.period_start AND CAST(COALESCE(ci.allocated_at, ci.updated_at) AS date) + 60
                ORDER BY e.id) AS candidates
    FROM charge_invoices ci
   WHERE ci.status = 'repartie' ${filtre('ci', ownerId)}
     AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.charge_invoice_id = ci.id)
   ORDER BY ci.created_at`, { ownerId });

const retenuesSansSortie = (ownerId) => requete(`
  SELECT dt.id, dt.owner_id
    FROM deposit_transactions dt
   WHERE dt.type = 'retenue' AND COALESCE(dt.contest_status, '') <> 'annulee' ${filtre('dt', ownerId)}
     AND NOT EXISTS (SELECT 1 FROM cash_movements cm WHERE cm.source_type = 'deposit_transaction' AND cm.source_id = dt.id AND cm.cancelled_at IS NULL)
   ORDER BY dt.created_at`, { ownerId });

/** Une retenue encore contestée attend la réponse du propriétaire. */
const retenuesNonImputees = (ownerId) => requete(`
  SELECT dt.id, dt.owner_id
    FROM deposit_transactions dt
   WHERE dt.type = 'retenue' AND dt.reason IN ('loyer_impaye', 'charges') AND dt.rent_payment_id IS NULL
     AND COALESCE(dt.contest_status, '') NOT IN ('annulee', 'conteste') ${filtre('dt', ownerId)}
   ORDER BY dt.created_at`, { ownerId });

const provisionsNonDeduites = (ownerId) => requete(`
  SELECT ci.id, ci.owner_id, ci.amount,
         EXISTS (SELECT 1 FROM charges c WHERE c.charge_invoice_id = ci.id AND c.amount_paid > 0) AS charge_encaissee
    FROM charge_invoices ci
   WHERE ci.status = 'repartie' AND ci.recharge_to_tenants ${filtre('ci', ownerId)}
     AND EXISTS (
       SELECT 1 FROM charge_allocations ca
         JOIN rent_schedules rs ON rs.lease_id = ca.lease_id AND rs.status <> 'annule' AND rs.charges_amount > 0
                               AND rs.period_start <= ci.period_end AND rs.period_end >= ci.period_start
        WHERE ca.charge_invoice_id = ci.id)
     AND NOT EXISTS (SELECT 1 FROM charge_allocations ca WHERE ca.charge_invoice_id = ci.id AND ca.provision_deducted > 0)
   ORDER BY ci.created_at`, { ownerId });

const resteDuBail = async (leaseId, t) => {
  const [{ reste }] = await requete(`
    SELECT (SELECT COALESCE(sum(amount_due - amount_paid), 0) FROM rent_schedules
             WHERE lease_id = :leaseId AND status IN ('a_payer', 'partiellement_paye', 'en_retard'))
         + (SELECT COALESCE(sum(amount - amount_paid), 0) FROM charges
             WHERE lease_id = :leaseId AND status IN ('a_payer', 'partiellement_paye', 'en_retard')) AS reste`, { leaseId }, t);
  return Number(reste);
};

/** Auteur d'une écriture de reprise : celui de la source, sinon le propriétaire. */
const auteur = async (id, ownerId, t) => {
  if (id) return { id };
  const [owner] = await requete('SELECT user_id AS id FROM owners WHERE id = :ownerId', { ownerId }, t);
  return owner;
};

async function reprendreFacture(ligne) {
  return sequelize.transaction(async (t) => {
    const invoice = await ChargeInvoice.findByPk(ligne.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (invoice.status !== 'repartie' || await Expense.count({ where: { charge_invoice_id: invoice.id }, transaction: t })) return null;
    let action;
    if (ligne.candidates.length === 1) {
      await Expense.update({ charge_invoice_id: invoice.id }, { where: { id: ligne.candidates[0], charge_invoice_id: null }, transaction: t });
      action = 'depense_rattachee';
    } else {
      await creerDepenseFacture(t, invoice, await auteur(invoice.created_by, invoice.owner_id, t), { date: ligne.date_repartition, silencieux: true });
      action = 'depense_creee';
    }
    await journaliser({
      action: 'rattrapage.facture', entityType: 'charge_invoice', entityId: invoice.id, ownerId: invoice.owner_id,
      details: { action, montant: invoice.amount, date: ligne.date_repartition },
    }, t);
    return action;
  });
}

const chargerRetenue = async (id, t) => {
  const repere = await DepositTransaction.findByPk(id, { attributes: ['deposit_id'], transaction: t });
  // Même ordre de verrous que le service de caution : la caution, puis la retenue.
  const deposit = await Deposit.findByPk(repere.deposit_id, { transaction: t, lock: t.LOCK.UPDATE });
  const tr = await DepositTransaction.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  const lease = await Lease.findByPk(deposit.lease_id, {
    include: [{ model: Apartment, as: 'apartment', attributes: ['id', 'building_id'], paranoid: false }],
    transaction: t,
  });
  return { deposit, tr, lease, user: await auteur(tr.created_by, deposit.owner_id, t) };
};

async function reprendreSortie(id) {
  return sequelize.transaction(async (t) => {
    const { deposit, tr, lease, user } = await chargerRetenue(id, t);
    const montant = montantRetenu(tr);
    if (montant <= 0) return 0;
    await sortieDeRetenue(t, { deposit, lease, tr, montant, user });
    await journaliser({
      action: 'rattrapage.retenue_caisse', entityType: 'deposit', entityId: deposit.id, ownerId: deposit.owner_id,
      details: { retenue: tr.id, montant },
    }, t);
    return montant;
  });
}

async function reprendreImputation(id) {
  return sequelize.transaction(async (t) => {
    const { deposit, tr, lease, user } = await chargerRetenue(id, t);
    if (tr.rent_payment_id) return 0;
    const montant = Math.min(montantRetenu(tr), await resteDuBail(lease.id, t));
    if (montant <= 0) return 0;
    await imputerRetenue(t, { lease, tr, montant, user });
    await journaliser({
      action: 'rattrapage.retenue_imputation', entityType: 'deposit', entityId: deposit.id, ownerId: deposit.owner_id,
      details: { retenue: tr.id, montant },
    }, t);
    return montant;
  });
}

/** État des lieux, sans aucune écriture. */
async function analyser({ ownerId = null } = {}) {
  const doublons = await facturesEnDouble(ownerId);
  const enDouble = new Set(doublons.flatMap((d) => d.ids));
  const factures = (await facturesSansDepense(ownerId)).filter((f) => !enDouble.has(f.id));
  return {
    doublons,
    factures_a_creer: factures.filter((f) => f.candidates.length === 0),
    factures_a_rattacher: factures.filter((f) => f.candidates.length === 1),
    factures_ambigues: factures.filter((f) => f.candidates.length > 1),
    retenues_sans_sortie: await retenuesSansSortie(ownerId),
    retenues_non_imputees: await retenuesNonImputees(ownerId),
    provisions_non_deduites: await provisionsNonDeduites(ownerId),
  };
}

/** Une erreur sur une ligne n'arrête pas les autres : elle est rapportée. */
async function pourChaque(lignes, action, erreurs) {
  const resultats = [];
  for (const ligne of lignes) {
    try {
      resultats.push(await action(ligne));
    } catch (e) {
      erreurs.push({ id: ligne.id, message: e.message });
    }
  }
  return resultats;
}

async function appliquer({ ownerId = null, imputerRetenues = false } = {}) {
  const a = await analyser({ ownerId });
  const erreurs = [];
  const factures = await pourChaque([...a.factures_a_creer, ...a.factures_a_rattacher], reprendreFacture, erreurs);
  const sorties = await pourChaque(a.retenues_sans_sortie, (l) => reprendreSortie(l.id), erreurs);
  const imputations = imputerRetenues ? await pourChaque(a.retenues_non_imputees, (l) => reprendreImputation(l.id), erreurs) : [];
  return {
    depenses_creees: factures.filter((r) => r === 'depense_creee').length,
    depenses_rattachees: factures.filter((r) => r === 'depense_rattachee').length,
    sorties_caisse: sorties.filter((m) => m > 0).length,
    retenues_imputees: imputations.filter((m) => m > 0).length,
    erreurs,
  };
}

module.exports = { analyser, appliquer };
