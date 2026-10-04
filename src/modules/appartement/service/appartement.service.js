'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { Apartment, Building, Lease, Tenant } = require('../../../models/index.js');
const { chargerPourProprietaire, verifierReference } = require('../../../utils/acces.js');
const { ordre, rechercheTexte } = require('../../../utils/liste.js');
const { ConflictError } = require('../../../errors/AppError.js');
const droits = require('../../abonnement/service/droits.service.js');
const documents = require('../../document/service/document.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Appartements (§ 8) : numéro, étage, type, surface, pièces, loyer, charges,
 * statut, locataire actuel et historiques (locataires, paiements, travaux,
 * dépenses).
 */

const CHAMPS = ['number', 'floor', 'type', 'surface', 'rooms_count', 'rent_amount', 'charges_amount', 'charge_coefficient', 'is_furnished', 'description'];

/** Bail actif et locataire actuel, joints en UNE requête (pas de N+1). */
const INCLUDE_OCCUPATION = [
  { model: Building, as: 'building', attributes: ['id', 'name', 'city'] },
  {
    model: Lease,
    as: 'leases',
    required: false,
    where: { status: 'actif' },
    attributes: ['id', 'reference', 'start_date', 'end_date', 'rent_amount', 'charges_amount'],
    include: [{ model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone'] }],
  },
];

function versApi(apartment) {
  const brut = apartment.toJSON();
  const bail = brut.leases?.[0] || null;
  delete brut.leases;
  return { ...brut, current_lease: bail ? { ...bail, tenant: undefined } : null, current_tenant: bail?.tenant || null };
}

async function lister(ownerId, filtres, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['building_id', 'status', 'type']) if (filtres[cle]) where[cle] = filtres[cle];
  const texte = rechercheTexte(filtres.q, ['number', 'description']);
  if (texte) Object.assign(where, texte);

  const { rows, count } = await Apartment.findAndCountAll({
    where,
    include: INCLUDE_OCCUPATION,
    order: ordre(filtres.tri, 'number'),
    limit,
    offset,
    distinct: true,
  });
  return { rows: rows.map(versApi), count };
}

async function detail(id, ownerId) {
  const apartment = await chargerPourProprietaire(Apartment, id, ownerId, { include: INCLUDE_OCCUPATION }, 'Appartement');
  const [pieces, locataires] = await Promise.all([
    documents.listerPourEntite('apartment', id),
    // Historique des locataires (§ 8) : tous les baux, du plus récent au plus ancien.
    Lease.findAll({
      where: { apartment_id: id },
      attributes: ['id', 'reference', 'status', 'start_date', 'end_date', 'ended_on', 'rent_amount'],
      include: [{ model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone'], paranoid: false }],
      order: [['start_date', 'DESC']],
      limit: 50,
    }),
  ]);
  return { ...versApi(apartment), documents: pieces.map(documents.versApi), tenant_history: locataires };
}

async function creer(ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    await verifierReference(Building, donnees.building_id, ownerId, 'Immeuble', { transaction: t });
    await droits.verifierLimite(ownerId, 'apartments', t);
    const apartment = await Apartment.create({ ...donnees, owner_id: ownerId, status: 'disponible' }, { transaction: t });
    await journaliser({
      action: 'appartement.creation', entityType: 'apartment', entityId: apartment.id, ownerId,
      details: { number: apartment.number, building_id: apartment.building_id, rent_amount: apartment.rent_amount },
    }, t);
    return apartment;
  });
}

async function modifier(id, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const apartment = await chargerPourProprietaire(Apartment, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Appartement');
    const avant = apartment.toJSON();
    await apartment.update(donnees, { transaction: t, fields: CHAMPS });
    const diff = difference(avant, donnees, CHAMPS);
    // § 40 : « modification de loyer » est une action journalisée à part.
    const action = diff.rent_amount || diff.charges_amount ? 'appartement.modification_loyer' : 'appartement.modification';
    await journaliser({ action, entityType: 'apartment', entityId: id, ownerId, details: diff }, t);
    return apartment;
  });
}

/**
 * Changement MANUEL de statut (§ 8). Règle § 41 « un appartement occupé doit
 * avoir un locataire actif » : `occupe` n'est posé que par l'activation d'un
 * bail, et un appartement sous bail actif ne peut pas être déclaré autre chose
 * qu'occupé. Le verrou de ligne empêche une activation concurrente.
 */
async function changerStatut(id, ownerId, { status }) {
  return sequelize.transaction(async (t) => {
    const apartment = await chargerPourProprietaire(Apartment, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Appartement');
    const bailActif = await Lease.count({ where: { apartment_id: id, status: 'actif' }, transaction: t });
    if (bailActif) {
      throw new ConflictError("L'appartement a un bail actif : son statut reste « Occupé » jusqu'à la fin du bail.", 'APPARTEMENT_OCCUPE');
    }
    const avant = apartment.status;
    await apartment.update({ status }, { transaction: t });
    await journaliser({ action: 'appartement.changement_statut', entityType: 'apartment', entityId: id, ownerId, details: { avant, apres: status } }, t);
    return apartment;
  });
}

/** Suppression logique (§ 42), interdite si l'appartement a déjà eu un bail. */
async function supprimer(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const apartment = await chargerPourProprietaire(Apartment, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Appartement');
    const baux = await Lease.count({ where: { apartment_id: id }, transaction: t });
    if (baux) {
      throw new ConflictError("Cet appartement a un historique de baux : il ne peut pas être supprimé. Passez-le « Indisponible ».", 'APPARTEMENT_AVEC_HISTORIQUE');
    }
    await apartment.destroy({ transaction: t });
    await journaliser({ action: 'appartement.suppression', entityType: 'apartment', entityId: id, ownerId, details: { number: apartment.number } }, t);
  });
}

/**
 * Historique chronologique de l'appartement (§ 25) : loyers payés, factures
 * réparties, dépenses, travaux, incidents — reconstruit par UNE requête
 * UNION ALL paginée, à partir des données jamais supprimées.
 */
async function historique(id, ownerId, { du, au }, { limit, offset }) {
  await chargerPourProprietaire(Apartment, id, ownerId, { attributes: ['id', 'owner_id'] }, 'Appartement');
  const sql = `
    WITH evenements AS (
      SELECT rp.paid_on::timestamptz AS date, 'loyer_paye' AS type, 'Paiement ' || rp.reference AS libelle,
             rp.amount AS montant, rp.id AS ressource_id, 'rent_payment' AS ressource_type
        FROM rent_payments rp WHERE rp.apartment_id = :id AND rp.status = 'valide'
      UNION ALL
      SELECT ci.allocated_at, 'facture_repartie', 'Facture ' || ci.charge_type || COALESCE(' ' || ci.supplier, ''),
             ca.amount, ci.id, 'charge_invoice'
        FROM charge_allocations ca JOIN charge_invoices ci ON ci.id = ca.charge_invoice_id
       WHERE ca.apartment_id = :id AND ci.status = 'repartie'
      UNION ALL
      SELECT e.spent_on::timestamptz, 'depense', COALESCE(e.description, c.name), -e.amount, e.id, 'expense'
        FROM expenses e JOIN expense_categories c ON c.id = e.category_id
       WHERE e.apartment_id = :id AND e.status = 'valide'
      UNION ALL
      SELECT w.created_at, 'travaux', 'Travaux #' || lpad(w.number::text, 5, '0') || ' — ' || w.title, NULL, w.id, 'work_order'
        FROM work_orders w WHERE w.apartment_id = :id
      UNION ALL
      SELECT i.created_at, 'incident', 'Incident signalé — ' || i.title, NULL, i.id, 'incident'
        FROM incidents i WHERE i.apartment_id = :id
    )
    SELECT *, count(*) OVER () AS total FROM evenements
     WHERE (CAST(:du AS date) IS NULL OR date >= CAST(:du AS date))
       AND (CAST(:au AS date) IS NULL OR date < CAST(:au AS date) + 1)
     ORDER BY date DESC NULLS LAST, ressource_id
     LIMIT :limit OFFSET :offset`;
  const lignes = await sequelize.query(sql, {
    replacements: { id, du: du || null, au: au || null, limit, offset },
    type: QueryTypes.SELECT,
  });
  const count = lignes[0] ? Number(lignes[0].total) : 0;
  return { rows: lignes.map(({ total, ...l }) => l), count };
}

/**
 * Rentabilité d'un appartement sur une période (§ 4 objectif 21, § 48 « quel
 * appartement coûte le plus cher ») : loyers et charges ENCAISSÉS, dépenses,
 * résultat net. La caution n'est jamais un revenu (§ 55.4).
 */
async function rentabilite(id, ownerId, { du, au }) {
  const apartment = await chargerPourProprietaire(Apartment, id, ownerId, { attributes: ['id', 'owner_id', 'number', 'rent_amount'] }, 'Appartement');
  const [ligne] = await sequelize.query(`
    SELECT
      (SELECT COALESCE(sum(pa.amount), 0) FROM payment_allocations pa
         JOIN rent_payments rp ON rp.id = pa.rent_payment_id
        WHERE rp.apartment_id = :id AND rp.status = 'valide' AND pa.reversed_at IS NULL
          AND pa.rent_schedule_id IS NOT NULL AND rp.paid_on BETWEEN :du AND :au) AS loyers_encaisses,
      (SELECT COALESCE(sum(pa.amount), 0) FROM payment_allocations pa
         JOIN rent_payments rp ON rp.id = pa.rent_payment_id
        WHERE rp.apartment_id = :id AND rp.status = 'valide' AND pa.reversed_at IS NULL
          AND pa.charge_id IS NOT NULL AND rp.paid_on BETWEEN :du AND :au) AS charges_recuperees,
      (SELECT COALESCE(sum(e.amount), 0) FROM expenses e
        WHERE e.apartment_id = :id AND e.status = 'valide' AND e.spent_on BETWEEN :du AND :au) AS depenses,
      (SELECT COALESCE(sum(rs.amount_due - rs.amount_paid), 0) FROM rent_schedules rs
        WHERE rs.apartment_id = :id AND rs.status IN ('a_payer', 'partiellement_paye', 'en_retard')
          AND rs.due_date BETWEEN :du AND :au) AS impayes`,
  { replacements: { id, du, au }, type: QueryTypes.SELECT });
  const revenus = ligne.loyers_encaisses + ligne.charges_recuperees;
  return {
    apartment: { id: apartment.id, number: apartment.number },
    periode: { du, au },
    loyers_encaisses: ligne.loyers_encaisses,
    charges_recuperees: ligne.charges_recuperees,
    revenus,
    depenses: ligne.depenses,
    resultat_net: revenus - ligne.depenses,
    impayes: ligne.impayes,
  };
}

module.exports = { lister, detail, creer, modifier, changerStatut, supprimer, historique, rentabilite };
