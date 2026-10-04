'use strict';

const sequelize = require('../../../config/db.js');
const {
  Charge, ChargeAllocation, ChargeInvoice, Tenant, Apartment, Building,
} = require('../../../models/index.js');
const { METHODE_REPARTITION, TYPE_CHARGE } = require('../../../config/enums.js');
const { DEFAUTS_PROPRIETAIRE } = require('../../../config/parametres.js');
const { chargerPourProprietaire, chargerPourLocataire } = require('../../../utils/acces.js');
const { ordre, periode } = require('../../../utils/liste.js');
const { aujourdhui } = require('../../../utils/dates.js');
const { statutCharge } = require('./repartition.calcul.js');

/**
 * Charges refacturées aux locataires (§ 15, § 16) : une ligne par
 * appartement occupé et par facture commune répartie.
 *
 * Ce module CRÉE les charges (répartition) et les lit ; leur ENCAISSEMENT
 * appartient au module paiement, seul à modifier `amount_paid` et le statut
 * payé (§ 41 « payé uniquement avec un paiement valide »). Il réutilise
 * `statutCharge` pour garder une seule définition des statuts.
 */

const ENCOURS = ['a_payer', 'partiellement_paye', 'en_retard'];

const INCLUDE_APPARTEMENT = {
  model: Apartment, as: 'apartment', attributes: ['id', 'number', 'building_id'], paranoid: false,
  include: [{ model: Building, as: 'building', attributes: ['id', 'name'], paranoid: false }],
};

const INCLUDE_LISTE = [
  { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone'], paranoid: false },
  INCLUDE_APPARTEMENT,
  { model: ChargeInvoice, as: 'invoice', attributes: ['id', 'supplier', 'invoice_number', 'period_start', 'period_end', 'allocation_method', 'amount', 'status'] },
];

/**
 * Recalcule le statut de TOUTES les charges en cours, en UNE requête, avec le
 * délai de grâce de chaque propriétaire (job quotidien) — même règle que
 * `statutCharge` et que les échéances de loyer : une charge non soldée dont
 * l'échéance est dépassée passe « en_retard », qu'elle soit partiellement
 * payée ou non. Retourne le nombre de lignes modifiées.
 */
async function mettreAJourStatutsCharges(jour = aujourdhui()) {
  const [, meta] = await sequelize.query(`
    UPDATE charges c SET status = calc.nouveau, updated_at = now()
      FROM (
        SELECT c2.id,
               CASE
                 WHEN c2.amount_paid >= c2.amount THEN 'paye'
                 WHEN CAST(:jour AS date) - c2.due_date > COALESCE((o.settings->>'late_grace_days')::int, :grace) THEN 'en_retard'
                 WHEN c2.amount_paid > 0 THEN 'partiellement_paye'
                 ELSE 'a_payer'
               END AS nouveau
          FROM charges c2 JOIN owners o ON o.id = c2.owner_id
         WHERE c2.status IN (:encours) AND c2.cancelled_at IS NULL
      ) calc
     WHERE c.id = calc.id AND c.status <> calc.nouveau`,
  { replacements: { jour, encours: ENCOURS, grace: DEFAUTS_PROPRIETAIRE.late_grace_days } });
  return meta?.rowCount ?? 0;
}

// ── Espace propriétaire ──────────────────────────────────────────────────────

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['tenant_id', 'lease_id', 'apartment_id', 'status', 'charge_invoice_id']) if (f[cle]) where[cle] = f[cle];
  const p = periode(f.du, f.au);
  if (p) where.due_date = p;
  const include = INCLUDE_LISTE.map((i) => ({ ...i }));
  if (f.building_id) include[1] = { ...include[1], required: true, where: { building_id: f.building_id } };

  return Charge.findAndCountAll({
    where,
    include,
    order: ordre(f.tri, '-due_date'),
    limit,
    offset,
  });
}

async function detail(id, ownerId) {
  const charge = await chargerPourProprietaire(Charge, id, ownerId, { include: INCLUDE_LISTE }, 'Charge');
  const allocation = await ChargeAllocation.findByPk(charge.charge_allocation_id, {
    attributes: ['id', 'basis_value', 'share', 'amount', 'explanation'],
  });
  return {
    ...charge.toJSON(),
    remaining: charge.amount - charge.amount_paid,
    allocation,
  };
}

// ── Espace locataire (§ 28 « Mes charges ») ──────────────────────────────────

/**
 * Attributs de facture montrables au locataire : ni notes internes du
 * propriétaire, ni rien qui concerne un autre appartement.
 */
const FACTURE_LOCATAIRE = ['id', 'charge_type', 'supplier', 'invoice_number', 'period_start', 'period_end', 'allocation_method', 'amount'];

async function listerLocataire(tenantIds, f, { limit, offset }) {
  const where = { tenant_id: tenantIds };
  if (f.status) where.status = f.status;
  return Charge.findAndCountAll({
    where,
    attributes: ['id', 'label', 'charge_type', 'amount', 'amount_paid', 'due_date', 'status', 'paid_at', 'created_at'],
    include: [
      INCLUDE_APPARTEMENT,
      { model: ChargeInvoice, as: 'invoice', attributes: ['id', 'supplier', 'period_start', 'period_end', 'allocation_method'] },
    ],
    order: ordre(f.tri, '-due_date'),
    limit,
    offset,
  });
}

/**
 * Détail d'une charge pour SON locataire, avec l'explication du calcul de SA
 * part et les totaux de la facture (méthode, montant total, nombre
 * d'appartements) — jamais le nom d'un autre locataire ni la part d'un autre
 * appartement (§ 28).
 */
async function detailLocataire(id, tenantIds) {
  const charge = await chargerPourLocataire(Charge, id, tenantIds, {
    attributes: ['id', 'tenant_id', 'lease_id', 'charge_invoice_id', 'charge_allocation_id', 'label', 'charge_type', 'amount', 'amount_paid', 'due_date', 'status', 'paid_at', 'cancelled_at', 'created_at'],
    include: [INCLUDE_APPARTEMENT, { model: ChargeInvoice, as: 'invoice', attributes: FACTURE_LOCATAIRE }],
  }, 'Charge');

  const [allocation, nbAppartements] = await Promise.all([
    ChargeAllocation.findByPk(charge.charge_allocation_id, { attributes: ['basis_value', 'share', 'amount', 'explanation'] }),
    ChargeAllocation.count({ where: { charge_invoice_id: charge.charge_invoice_id } }),
  ]);
  const { invoice, apartment } = charge;

  return {
    id: charge.id,
    lease_id: charge.lease_id,
    label: charge.label,
    charge_type: charge.charge_type,
    charge_type_label: TYPE_CHARGE[charge.charge_type],
    amount: charge.amount,
    amount_paid: charge.amount_paid,
    remaining: charge.status === 'annule' ? 0 : charge.amount - charge.amount_paid,
    due_date: charge.due_date,
    status: charge.status,
    paid_at: charge.paid_at,
    created_at: charge.created_at,
    apartment: apartment ? { id: apartment.id, number: apartment.number, building: apartment.building ? { id: apartment.building.id, name: apartment.building.name } : null } : null,
    calculation: {
      method: invoice.allocation_method,
      method_label: METHODE_REPARTITION[invoice.allocation_method],
      invoice_total: invoice.amount,
      apartments_count: nbAppartements,
      supplier: invoice.supplier,
      invoice_number: invoice.invoice_number,
      period_start: invoice.period_start,
      period_end: invoice.period_end,
      basis_value: allocation.basis_value,
      share: allocation.share,
      amount: allocation.amount,
      explanation: allocation.explanation,
    },
  };
}

module.exports = {
  statutCharge, mettreAJourStatutsCharges, lister, detail, listerLocataire, detailLocataire, ENCOURS,
};
