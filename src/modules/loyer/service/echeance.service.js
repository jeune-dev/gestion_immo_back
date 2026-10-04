'use strict';

const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  RentSchedule, Lease, Tenant, Apartment, Building, PaymentAllocation, RentPayment, Receipt, PaymentTransaction,
} = require('../../../models/index.js');
const { MOIS_PAR_PERIODICITE } = require('../../../config/enums.js');
const { DEFAUTS_PROPRIETAIRE } = require('../../../config/parametres.js');
const {
  aujourdhui, ajouterMois, ajouterJours, avecJour, ecartJours, libelleMois,
} = require('../../../utils/dates.js');
const { chargerPourProprietaire } = require('../../../utils/acces.js');
const { ordre, periode } = require('../../../utils/liste.js');
const { ConflictError } = require('../../../errors/AppError.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const parametres = require('../../parametres/service/parametres.service.js');

/**
 * Échéances de loyer (§ 10 « générer automatiquement les échéances à partir
 * du contrat », § 11 statuts).
 *
 * Génération :
 *   - périodes successives depuis la date de début, selon la périodicité
 *     (1, 2, 3, 6 ou 12 mois) ;
 *   - échéance au jour convenu (`due_day`) du premier mois de la période,
 *     jamais avant le début de la période ;
 *   - montant = (loyer + provision de charges) × nombre de mois ; la
 *     DERNIÈRE période, coupée par la date de fin du bail, est proratisée au
 *     nombre de jours ;
 *   - horizon glissant de 12 mois pour un bail sans fin (le job quotidien
 *     prolonge l'horizon) ; jusqu'à la fin du bail sinon.
 *
 * Idempotente : une période déjà générée n'est jamais recréée (UNIQUE
 * lease_id + period_start).
 */

const HORIZON_MOIS = parseInt(process.env.ECHEANCES_HORIZON_MOIS || '12', 10);
const ENCOURS = ['a_venir', 'a_payer', 'partiellement_paye', 'en_retard'];

function libelle(debut, fin, mois) {
  if (mois === 1) return `Loyer ${libelleMois(debut)}`;
  return `Loyer ${libelleMois(debut)} – ${libelleMois(fin)}`;
}

/**
 * Statut d'une échéance à une date donnée (fonction pure, testée unitairement).
 * @param {{ amount_due: number, amount_paid: number, due_date: string, cancelled_at?: any }} e
 * @param {string} jour AAAA-MM-JJ
 * @param {{ schedule_notice_days: number, late_grace_days: number }} reglages
 */
function statutA(e, jour, reglages = DEFAUTS_PROPRIETAIRE) {
  if (e.cancelled_at) return 'annule';
  if (e.amount_paid >= e.amount_due) return 'paye';
  if (ecartJours(e.due_date, jour) > (reglages.late_grace_days ?? 0)) return 'en_retard';
  if (e.amount_paid > 0) return 'partiellement_paye';
  if (ecartJours(jour, e.due_date) <= (reglages.schedule_notice_days ?? 5)) return 'a_payer';
  return 'a_venir';
}

/**
 * Calcule les périodes à générer pour un bail (fonction pure).
 * @param {object} bail  start_date, end_date, periodicity, due_day, rent_amount, charges_amount
 * @param {string|null} dernierDebut  début de la dernière période déjà générée
 * @param {string} limite            ne génère pas de période commençant après
 */
function periodesAGenerer(bail, dernierDebut, limite) {
  const mois = MOIS_PAR_PERIODICITE[bail.periodicity];
  const resultat = [];
  let debut = dernierDebut ? ajouterMois(dernierDebut, mois) : bail.start_date;
  let k = 0;
  while (debut <= limite && (!bail.end_date || debut <= bail.end_date) && k < 400) {
    const finPleine = ajouterJours(ajouterMois(debut, mois), -1);
    const fin = bail.end_date && bail.end_date < finPleine ? bail.end_date : finPleine;
    let rent = bail.rent_amount * mois;
    let charges = bail.charges_amount * mois;
    if (fin !== finPleine) {
      // Prorata au jour de la dernière période, arrondi au franc.
      const ratio = (ecartJours(debut, fin) + 1) / (ecartJours(debut, finPleine) + 1);
      rent = Math.round(rent * ratio);
      charges = Math.round(charges * ratio);
    }
    const echeance = avecJour(debut, bail.due_day) < debut ? debut : avecJour(debut, bail.due_day);
    if (rent + charges > 0) {
      resultat.push({
        period_start: debut, period_end: fin, due_date: echeance,
        rent_amount: rent, charges_amount: charges, amount_due: rent + charges,
        label: libelle(debut, fin, mois),
      });
    }
    debut = ajouterMois(debut, mois);
    k += 1;
  }
  return resultat;
}

/**
 * Génère (ou prolonge) les échéances d'un bail actif.
 * @returns {Promise<number>} nombre d'échéances créées
 */
async function generer(lease, reglages, t, jour = aujourdhui()) {
  const derniere = await RentSchedule.findOne({
    where: { lease_id: lease.id },
    attributes: ['period_start'],
    order: [['period_start', 'DESC']],
    transaction: t,
  });
  const base = lease.start_date > jour ? lease.start_date : jour;
  const limite = ajouterMois(base, HORIZON_MOIS);
  const periodes = periodesAGenerer(lease, derniere?.period_start || null, limite);
  if (!periodes.length) return 0;

  await RentSchedule.bulkCreate(periodes.map((p) => ({
    ...p,
    owner_id: lease.owner_id,
    lease_id: lease.id,
    apartment_id: lease.apartment_id,
    tenant_id: lease.tenant_id,
    amount_paid: 0,
    status: statutA({ ...p, amount_paid: 0 }, jour, reglages),
  })), { transaction: t, ignoreDuplicates: true });
  return periodes.length;
}

/**
 * Recalcule le statut de TOUTES les échéances en cours, en UNE requête, avec
 * les délais de chaque propriétaire (job quotidien). Retourne le nombre de
 * lignes modifiées.
 */
async function mettreAJourStatuts(jour = aujourdhui()) {
  const [, meta] = await sequelize.query(`
    UPDATE rent_schedules rs SET status = calc.nouveau, updated_at = now()
      FROM (
        SELECT rs2.id,
               CASE
                 WHEN rs2.amount_paid >= rs2.amount_due THEN 'paye'
                 WHEN CAST(:jour AS date) - rs2.due_date > COALESCE((o.settings->>'late_grace_days')::int, :grace) THEN 'en_retard'
                 WHEN rs2.amount_paid > 0 THEN 'partiellement_paye'
                 WHEN rs2.due_date - CAST(:jour AS date) <= COALESCE((o.settings->>'schedule_notice_days')::int, :preavis) THEN 'a_payer'
                 ELSE 'a_venir'
               END AS nouveau
          FROM rent_schedules rs2 JOIN owners o ON o.id = rs2.owner_id
         WHERE rs2.status IN (:encours)
      ) calc
     WHERE rs.id = calc.id AND rs.status <> calc.nouveau`,
  {
    replacements: {
      jour, encours: ENCOURS,
      grace: DEFAUTS_PROPRIETAIRE.late_grace_days, preavis: DEFAUTS_PROPRIETAIRE.schedule_notice_days,
    },
  });
  return meta?.rowCount ?? 0;
}

/** Durée d'une période en mois, en SQL (même table que MOIS_PAR_PERIODICITE). */
const MOIS_SQL = `CASE l.periodicity ${Object.entries(MOIS_PAR_PERIODICITE)
  .map(([code, mois]) => `WHEN '${code}' THEN ${Number(mois)}`).join(' ')} END`;

/**
 * Prolonge l'horizon des baux actifs sans fin proche (job quotidien).
 *
 * Seuls les baux dont la PROCHAINE période (dernière + périodicité, comme
 * `periodesAGenerer`) commence dans l'horizon — et avant la fin du bail — sont
 * traités : un jour ordinaire, quelques baux sur des milliers. Auparavant,
 * tout bail dont la dernière période précédait l'horizon était repris, soit
 * chaque jour une transaction verrouillante par bail pour ne rien générer
 * (550 baux : 1 750 requêtes — docs/PERFORMANCE.md).
 */
async function prolongerHorizons(jour = aujourdhui()) {
  const limite = ajouterMois(jour, HORIZON_MOIS);
  const baux = await sequelize.query(`
    SELECT l.id FROM leases l
     CROSS JOIN LATERAL (SELECT max(r.period_start) AS dernier FROM rent_schedules r WHERE r.lease_id = l.id) d
     CROSS JOIN LATERAL (
       SELECT CASE WHEN d.dernier IS NULL THEN l.start_date
                   ELSE (d.dernier + make_interval(months => ${MOIS_SQL}))::date END AS prochain
     ) p
     WHERE l.status = 'actif'
       AND p.prochain <= CAST(:limite AS date)
       AND (l.end_date IS NULL OR p.prochain <= l.end_date)`,
  { replacements: { limite }, type: QueryTypes.SELECT });
  let total = 0;
  for (const { id } of baux) {
    total += await sequelize.transaction(async (t) => {
      const lease = await Lease.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
      if (!lease || lease.status !== 'actif') return 0;
      return generer(lease, await parametres.proprietaire(lease.owner_id, t), t, jour);
    });
  }
  return total;
}

// ── Lecture (espace propriétaire) ────────────────────────────────────────────

const INCLUDE_LISTE = [
  { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone'], paranoid: false },
  { model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false, include: [{ model: Building, as: 'building', attributes: ['id', 'name'], paranoid: false }] },
];

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['lease_id', 'tenant_id', 'apartment_id']) if (f[cle]) where[cle] = f[cle];
  if (f.status) where.status = f.status;
  if (f.impayes) where.status = { [Op.in]: ['en_retard', 'partiellement_paye'] };
  const p = periode(f.du, f.au);
  if (p) where.due_date = p;
  const include = INCLUDE_LISTE.map((i) => ({ ...i }));
  if (f.building_id) include[1] = { ...include[1], required: true, where: { building_id: f.building_id } };

  return RentSchedule.findAndCountAll({
    where,
    include,
    order: ordre(f.tri, 'due_date'),
    limit,
    offset,
  });
}

async function detail(id, ownerId) {
  const echeance = await chargerPourProprietaire(RentSchedule, id, ownerId, {
    include: [
      ...INCLUDE_LISTE,
      {
        model: PaymentAllocation, as: 'allocations', required: false, where: { reversed_at: null },
        attributes: ['id', 'amount', 'created_at'],
        include: [{ model: RentPayment, as: 'payment', attributes: ['id', 'reference', 'method', 'paid_on', 'status'] }],
      },
      { model: Receipt, as: 'receipt', required: false, where: { cancelled_at: null }, attributes: ['id', 'number', 'issued_at'] },
    ],
  }, 'Échéance');
  return echeance;
}

/** Annulation d'une échéance non encaissée (erreur, geste commercial) — § 11 « Annulé ». */
async function annuler(id, ownerId, motif) {
  return sequelize.transaction(async (t) => {
    const e = await chargerPourProprietaire(RentSchedule, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Échéance');
    if (e.status === 'annule') throw new ConflictError('Échéance déjà annulée', 'DEJA_ANNULE');
    if (e.amount_paid > 0) throw new ConflictError('Une échéance ayant reçu un paiement ne peut pas être annulée : remboursez d’abord le paiement.', 'ECHEANCE_ENCAISSEE');
    // Paiement en vol (demande Wave / Orange Money en cours, preuve à valider) :
    // l'annuler maintenant rendrait la confirmation à venir inimputable (§ 51.3).
    const enCours = await PaymentTransaction.count({
      where: { rent_schedule_id: id, status: { [Op.in]: ['initiee', 'en_attente'] } },
      transaction: t,
    });
    if (enCours) {
      throw new ConflictError(
        'Un paiement est en cours sur cette échéance : attendez sa confirmation, son échec ou son expiration avant de l’annuler.',
        'PAIEMENT_EN_COURS'
      );
    }
    await e.update({ status: 'annule', cancelled_at: new Date(), cancel_reason: motif }, { transaction: t });
    await journaliser({ action: 'echeance.changement_statut', entityType: 'rent_schedule', entityId: id, ownerId, details: { apres: 'annule', motif, montant: e.amount_due } }, t);
    return e;
  });
}

/** Tri stable des échéances ouvertes d'un bail, de la plus ancienne à la plus récente. */
async function ouvertesDuBail(leaseId, t) {
  return RentSchedule.findAll({
    where: { lease_id: leaseId, status: { [Op.in]: ENCOURS } },
    order: [['due_date', 'ASC'], ['period_start', 'ASC']],
    transaction: t,
    lock: t?.LOCK.UPDATE,
  });
}

module.exports = {
  statutA, periodesAGenerer, generer, mettreAJourStatuts, prolongerHorizons,
  lister, detail, annuler, ouvertesDuBail, ENCOURS,
};
