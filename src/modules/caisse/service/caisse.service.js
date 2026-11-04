'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { CashMovement, Building, Apartment } = require('../../../models/index.js');
const { chargerPourProprietaire, verifierReference } = require('../../../utils/acces.js');
const { ConflictError, ValidationError } = require('../../../errors/AppError.js');
const { periode } = require('../../../utils/liste.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const { invaliderTableauDeBord } = require('../../../utils/cache.js');

/**
 * Caisse (§ 21) : journal des entrées et sorties.
 *
 * Entrées : loyers, charges, autres revenus (et cautions, à part).
 * Sorties : travaux, entretien, factures, nettoyage, sécurité, autres dépenses.
 *
 * Les mouvements sont créés AUTOMATIQUEMENT, dans la transaction de leur
 * source : paiement de loyer, dépense (§ 41 « une dépense en espèces doit être
 * enregistrée dans la caisse »), mouvement de caution. Seuls les « autres
 * revenus » se saisissent à la main. Un mouvement n'est jamais supprimé : il
 * est ANNULÉ quand sa source l'est (remboursement, annulation de dépense).
 *
 * La caution (§ 55.4) est comptée à part (`is_deposit`) : elle apparaît dans la
 * trésorerie détenue, jamais dans les revenus ni la rentabilité.
 */

/**
 * @param {import('sequelize').Transaction} t
 * @param {object} m
 */
async function enregistrerMouvement(t, {
  ownerId, buildingId = null, apartmentId = null, direction, category, amount, method,
  occurredOn, label, sourceType, sourceId = null, createdBy = null,
}) {
  t.afterCommit(() => invaliderTableauDeBord(ownerId));
  return CashMovement.create({
    owner_id: ownerId,
    building_id: buildingId,
    apartment_id: apartmentId,
    direction,
    category,
    amount,
    method,
    occurred_on: occurredOn,
    label: String(label).slice(0, 200),
    source_type: sourceType,
    source_id: sourceId,
    is_deposit: category === 'caution',
    created_by: createdBy,
  }, { transaction: t });
}

/** Annule les mouvements d'une source (remboursement, annulation de dépense). */
async function annulerParSource(t, sourceType, sourceId) {
  const [n, lignes] = await CashMovement.update(
    { cancelled_at: new Date() },
    { where: { source_type: sourceType, source_id: sourceId, cancelled_at: null }, transaction: t, returning: ['owner_id'] }
  );
  if (lignes?.[0]) t.afterCommit(() => invaliderTableauDeBord(lignes[0].owner_id));
  return n;
}

/** Fait passer `montant` de la catégorie « loyer » à « charges » pour un paiement déjà en caisse. */
async function reclasserLoyerEnCharges(t, paiement, montant) {
  const loyer = await CashMovement.findOne({
    where: { source_type: 'rent_payment', source_id: paiement.id, category: 'loyer', direction: 'entree', cancelled_at: null },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!loyer) return;
  if (loyer.amount <= montant) {
    await loyer.update({ category: 'charges', label: loyer.label.replace(/^Loyer/, 'Charges') }, { transaction: t });
    return;
  }
  await loyer.update({ amount: loyer.amount - montant }, { transaction: t });
  await enregistrerMouvement(t, {
    ownerId: loyer.owner_id, buildingId: loyer.building_id, apartmentId: loyer.apartment_id, direction: 'entree',
    category: 'charges', amount: montant, method: loyer.method, occurredOn: loyer.occurred_on,
    label: loyer.label.replace(/^Loyer/, 'Charges'), sourceType: 'rent_payment', sourceId: paiement.id, createdBy: loyer.created_by,
  });
}

function filtresJournal(ownerId, { du, au, building_id: buildingId, direction, category, method, inclure_cautions: inclureCautions }) {
  const where = { owner_id: ownerId, cancelled_at: null };
  const p = periode(du, au);
  if (p) where.occurred_on = p;
  if (buildingId) where.building_id = buildingId;
  if (direction) where.direction = direction;
  if (category) where.category = category;
  if (method) where.method = method;
  if (!inclureCautions && !category) where.is_deposit = false;
  return where;
}

async function journal(ownerId, filtres, { limit, offset }) {
  return CashMovement.findAndCountAll({
    where: filtresJournal(ownerId, filtres),
    include: [
      { model: Building, as: 'building', attributes: ['id', 'name'] },
      { model: Apartment, as: 'apartment', attributes: ['id', 'number'] },
    ],
    order: [['occurred_on', 'DESC'], ['created_at', 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
}

/**
 * Synthèse de caisse sur une période (§ 21 « CAISSE SEPTEMBRE : entrées,
 * sorties, solde ») : totaux par catégorie en UNE requête agrégée.
 * Les cautions sont présentées à part et exclues du solde d'exploitation.
 */
async function synthese(ownerId, { du, au, building_id: buildingId }) {
  const lignes = await sequelize.query(`
    SELECT cm.direction, cm.category, cm.is_deposit, (dt.type = 'retenue') IS TRUE AS est_retenue,
           sum(cm.amount)::bigint AS total, count(*)::int AS nombre
      FROM cash_movements cm
      LEFT JOIN deposit_transactions dt ON cm.source_type = 'deposit_transaction' AND dt.id = cm.source_id
     WHERE cm.owner_id = :ownerId AND cm.cancelled_at IS NULL
       AND cm.occurred_on BETWEEN :du AND :au
       AND (CAST(:buildingId AS uuid) IS NULL OR cm.building_id = CAST(:buildingId AS uuid))
     GROUP BY cm.direction, cm.category, cm.is_deposit, est_retenue`,
  { replacements: { ownerId, du, au, buildingId: buildingId || null }, type: QueryTypes.SELECT });

  const exploitation = lignes.filter((l) => !l.is_deposit);
  const somme = (sens) => exploitation.filter((l) => l.direction === sens).reduce((a, l) => a + l.total, 0);
  const entrees = somme('entree');
  const sorties = somme('sortie');
  const cautions = lignes.filter((l) => l.is_deposit);
  const cautionEntrees = cautions.filter((l) => l.direction === 'entree').reduce((a, l) => a + l.total, 0);
  const cautionSorties = cautions.filter((l) => l.direction === 'sortie').reduce((a, l) => a + l.total, 0);
  const cautionRetenues = cautions.filter((l) => l.est_retenue).reduce((a, l) => a + l.total, 0);

  return {
    periode: { du, au },
    entrees,
    sorties,
    solde: entrees - sorties,
    detail_entrees: exploitation.filter((l) => l.direction === 'entree').map(({ category, total, nombre }) => ({ category, total, nombre })),
    detail_sorties: exploitation.filter((l) => l.direction === 'sortie').map(({ category, total, nombre }) => ({ category, total, nombre })),
    cautions: {
      recues: cautionEntrees, restituees: cautionSorties - cautionRetenues, retenues: cautionRetenues, solde: cautionEntrees - cautionSorties,
    },
  };
}

/**
 * Saisie manuelle d'un « autre revenu » (§ 21). L'appartement, s'il est
 * indiqué, doit appartenir à l'immeuble indiqué ; seul, il détermine
 * l'immeuble — sans quoi le revenu serait compté dans le mauvais immeuble (ou
 * dans aucun) des rapports par immeuble et de la rentabilité (§ 26).
 */
async function ajouterAutreRevenu(ownerId, user, donnees) {
  return sequelize.transaction(async (t) => {
    let buildingId = donnees.building_id || null;
    if (buildingId) await verifierReference(Building, buildingId, ownerId, 'Immeuble', { transaction: t });
    if (donnees.apartment_id) {
      const apartment = await verifierReference(Apartment, donnees.apartment_id, ownerId, 'Appartement', { transaction: t });
      if (buildingId && apartment.building_id !== buildingId) {
        throw new ValidationError('Données invalides', ["L'appartement n'appartient pas à l'immeuble indiqué"], 'APPARTEMENT_HORS_IMMEUBLE');
      }
      buildingId = apartment.building_id;
    }
    const mouvement = await enregistrerMouvement(t, {
      ownerId,
      buildingId,
      apartmentId: donnees.apartment_id || null,
      direction: 'entree',
      category: 'autre_revenu',
      amount: donnees.amount,
      method: donnees.method,
      occurredOn: donnees.occurred_on,
      label: donnees.label,
      sourceType: 'manuel',
      createdBy: user.id,
    });
    await journaliser({ action: 'caisse.creation', entityType: 'cash_movement', entityId: mouvement.id, ownerId, details: { montant: donnees.amount, libelle: donnees.label } }, t);
    return mouvement;
  });
}

/** Annulation d'une saisie MANUELLE (les mouvements automatiques suivent leur source). */
async function annulerManuel(ownerId, id, motif) {
  return sequelize.transaction(async (t) => {
    const m = await chargerPourProprietaire(CashMovement, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Mouvement de caisse');
    if (m.source_type !== 'manuel') {
      throw new ConflictError("Ce mouvement provient d'un paiement, d'une dépense ou d'une caution : annulez la source.", 'MOUVEMENT_AUTOMATIQUE');
    }
    if (m.cancelled_at) throw new ConflictError('Mouvement déjà annulé', 'DEJA_ANNULE');
    await m.update({ cancelled_at: new Date() }, { transaction: t });
    await journaliser({ action: 'caisse.suppression', entityType: 'cash_movement', entityId: id, ownerId, details: { montant: m.amount, motif } }, t);
    return m;
  });
}

module.exports = { enregistrerMouvement, annulerParSource, reclasserLoyerEnCharges, journal, synthese, ajouterAutreRevenu, annulerManuel };
