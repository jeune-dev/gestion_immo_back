'use strict';

const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Lease, Apartment, Building, Owner, RentSchedule, Tenant, PaymentAllocation, RentPayment, Receipt,
} = require('../../../models/index.js');
const { chargerPourLocataire } = require('../../../utils/acces.js');
const { periode } = require('../../../utils/liste.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const { ForbiddenError } = require('../../../errors/AppError.js');

/**
 * Espace locataire (§ 28) : « interface beaucoup plus simple ».
 *
 * Toutes les lectures sont filtrées par `req.tenantIds` (fiches locataire du
 * compte) : le locataire ne voit JAMAIS les informations des autres
 * locataires, ni les données du propriétaire au-delà de ce qui le concerne
 * (nom du bailleur, bien loué).
 */

const INCLUDE_LOGEMENT = [
  {
    model: Apartment, as: 'apartment', attributes: ['id', 'number', 'floor', 'type', 'surface', 'rooms_count', 'is_furnished'], paranoid: false,
    include: [{ model: Building, as: 'building', attributes: ['id', 'name', 'address', 'district', 'city'], paranoid: false }],
  },
  { model: Owner, as: 'owner', attributes: ['id', 'display_name', 'company_name', 'phone'] },
];

const ATTRIBUTS_BAIL = ['id', 'reference', 'status', 'lease_type', 'start_date', 'end_date', 'ended_on', 'rent_amount', 'charges_amount', 'deposit_amount', 'periodicity', 'due_day', 'tenant_id'];

/** « Mon logement » : baux actifs d'abord, puis l'historique. */
async function logements(tenantIds) {
  return Lease.findAll({
    where: { tenant_id: { [Op.in]: tenantIds }, status: { [Op.in]: ['actif', 'termine', 'clos'] } },
    attributes: ATTRIBUTS_BAIL,
    include: INCLUDE_LOGEMENT,
    order: [[sequelize.literal("CASE WHEN \"Lease\".\"status\" = 'actif' THEN 0 ELSE 1 END"), 'ASC'], ['start_date', 'DESC']],
  });
}

/**
 * Accueil (§ 28) : résidence, appartement, loyer, prochaine échéance et reste
 * dû — tout ce qu'il faut pour afficher le bouton [PAYER] en UNE requête SQL
 * de plus que la liste des logements.
 */
async function accueil(tenantIds) {
  const [baux, echeances] = await Promise.all([
    logements(tenantIds),
    sequelize.query(`
      SELECT DISTINCT ON (rs.lease_id) rs.lease_id, rs.id, rs.label, rs.due_date, rs.amount_due, rs.amount_paid, rs.status
        FROM rent_schedules rs
       WHERE rs.tenant_id IN (:tenantIds) AND rs.status IN ('a_venir', 'a_payer', 'partiellement_paye', 'en_retard')
       ORDER BY rs.lease_id, rs.due_date ASC`,
    { replacements: { tenantIds }, type: QueryTypes.SELECT }),
  ]);
  const soldes = await sequelize.query(`
    SELECT lease_id,
           COALESCE(sum(amount_due - amount_paid) FILTER (WHERE status IN ('a_payer', 'partiellement_paye', 'en_retard')), 0) AS reste_du,
           COALESCE(sum(amount_due - amount_paid) FILTER (WHERE status = 'en_retard'), 0) AS en_retard
      FROM rent_schedules WHERE tenant_id IN (:tenantIds) GROUP BY lease_id`,
  { replacements: { tenantIds }, type: QueryTypes.SELECT });
  const prochaine = new Map(echeances.map((e) => [e.lease_id, e]));
  const solde = new Map(soldes.map((s) => [s.lease_id, s]));
  return baux.filter((b) => b.status === 'actif').map((b) => ({
    lease: b,
    next_schedule: prochaine.get(b.id) || null,
    amount_due: solde.get(b.id)?.reste_du ?? 0,
    amount_overdue: solde.get(b.id)?.en_retard ?? 0,
  }));
}

async function echeances(tenantIds, f, { limit, offset }) {
  const where = { tenant_id: { [Op.in]: tenantIds }, status: { [Op.ne]: 'annule' } };
  if (f.lease_id) where.lease_id = f.lease_id;
  if (f.status) where.status = f.status;
  if (f.a_payer) where.status = { [Op.in]: ['a_payer', 'partiellement_paye', 'en_retard'] };
  const p = periode(f.du, f.au);
  if (p) where.due_date = p;
  return RentSchedule.findAndCountAll({
    where,
    attributes: ['id', 'lease_id', 'label', 'period_start', 'period_end', 'due_date', 'rent_amount', 'charges_amount', 'amount_due', 'amount_paid', 'status', 'paid_at'],
    order: [['due_date', f.ordre === 'asc' ? 'ASC' : 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
}

async function echeance(tenantIds, id) {
  return chargerPourLocataire(RentSchedule, id, tenantIds, {
    attributes: { exclude: ['owner_id', 'cancel_reason'] },
    include: [
      {
        model: PaymentAllocation, as: 'allocations', required: false, where: { reversed_at: null }, attributes: ['id', 'amount', 'created_at'],
        include: [{ model: RentPayment, as: 'payment', attributes: ['id', 'reference', 'method', 'paid_on'] }],
      },
      { model: Receipt, as: 'receipt', required: false, where: { cancelled_at: null }, attributes: ['id', 'number', 'issued_at'] },
    ],
  }, 'Échéance');
}

/**
 * Consentement WhatsApp (§ 54.3) : le locataire le donne ou le retire à tout
 * moment, pour une fiche (un bailleur) ou pour toutes.
 */
async function consentementWhatsapp(tenantIds, { accorde, tenant_id: tenantId }) {
  const cibles = tenantId ? [tenantId] : tenantIds;
  if (tenantId && !tenantIds.includes(tenantId)) {
    throw new ForbiddenError("Vous n'avez pas accès à cette fiche.", 'ACCES_AUTRE_LOCATAIRE');
  }
  return sequelize.transaction(async (t) => {
    const fiches = await Tenant.findAll({ where: { id: cibles }, transaction: t, lock: t.LOCK.UPDATE });
    for (const fiche of fiches) {
      await fiche.update(accorde
        ? { whatsapp_consent: true, whatsapp_consent_at: new Date(), whatsapp_consent_revoked_at: null }
        : { whatsapp_consent: false, whatsapp_consent_revoked_at: new Date() }, { transaction: t });
      await journaliser({ action: 'locataire.consentement_whatsapp', entityType: 'tenant', entityId: fiche.id, ownerId: fiche.owner_id, details: { accorde, par: 'locataire' } }, t);
    }
    return fiches.map((f) => ({ tenant_id: f.id, whatsapp_consent: f.whatsapp_consent }));
  });
}

module.exports = { logements, accueil, echeances, echeance, consentementWhatsapp };
