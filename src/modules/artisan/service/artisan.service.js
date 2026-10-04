'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { Contractor, WorkOrder, Building, Apartment } = require('../../../models/index.js');
const { chargerPourProprietaire } = require('../../../utils/acces.js');
const { ordre, rechercheTexte } = require('../../../utils/liste.js');
const { pad } = require('../../../utils/compteur.js');
const { ConflictError } = require('../../../errors/AppError.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Artisans (§ 24) : carnet d'adresses du propriétaire (pas de marketplace en
 * V1). « Le système conserve l'historique des interventions » : un artisan
 * n'est jamais supprimé physiquement — désactivé (plus proposé à
 * l'affectation) ou supprimé LOGIQUEMENT (§ 42), ses travaux et dépenses
 * passés restant consultables.
 */

const CHAMPS = ['name', 'phone', 'trade', 'email', 'notes'];

/** Travaux encore « ouverts » : un artisan qui y intervient ne peut pas être retiré. */
const STATUTS_EN_COURS = ['artisan_assigne', 'en_cours'];

/**
 * Nombre d'interventions et total dépensé calculés DANS la requête de liste
 * (sous-requêtes corrélées sur les index work_orders_contractor_idx et
 * expenses.contractor_id) : une requête pour la page, pas une par artisan.
 */
const ATTRIBUTS_STATS = [
  [sequelize.literal('(SELECT count(*) FROM work_orders w WHERE w.contractor_id = "Contractor"."id")'), 'interventions_count'],
  [sequelize.literal('(SELECT COALESCE(sum(e.amount), 0) FROM expenses e WHERE e.contractor_id = "Contractor"."id" AND e.status = \'valide\')'), 'total_spent'],
];

/** '' envoyé par un formulaire mobile vidé = valeur absente. */
function normaliser(donnees) {
  const propre = { ...donnees };
  for (const champ of ['phone', 'email', 'notes']) if (propre[champ] === '') propre[champ] = null;
  return propre;
}

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  if (f.trade) where.trade = f.trade;
  if (f.is_active !== undefined) where.is_active = f.is_active;
  const texte = rechercheTexte(f.q, ['name', 'phone', 'email']);
  if (texte) Object.assign(where, texte);
  return Contractor.findAndCountAll({
    where,
    attributes: { include: ATTRIBUTS_STATS },
    order: ordre(f.tri, 'name'),
    limit,
    offset,
  });
}

/**
 * Fiche artisan : historique des interventions (§ 24) et total dépensé —
 * deux requêtes fixes, quel que soit le nombre de travaux.
 */
async function detail(id, ownerId) {
  const contractor = await chargerPourProprietaire(Contractor, id, ownerId, {}, 'Artisan');
  const [travaux, [totaux]] = await Promise.all([
    WorkOrder.findAll({
      where: { contractor_id: id, owner_id: ownerId },
      attributes: ['id', 'number', 'title', 'category', 'status', 'priority', 'estimated_amount', 'actual_amount', 'scheduled_for', 'completed_at', 'created_at'],
      include: [
        { model: Building, as: 'building', attributes: ['id', 'name'], paranoid: false },
        { model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false },
      ],
      order: [['created_at', 'DESC'], ['id', 'ASC']],
    }),
    sequelize.query(
      `SELECT COALESCE(sum(amount), 0)::bigint AS total_spent, count(*)::int AS expenses_count
         FROM expenses WHERE owner_id = :ownerId AND contractor_id = :id AND status = 'valide'`,
      { replacements: { ownerId, id }, type: QueryTypes.SELECT }
    ),
  ]);
  return {
    ...contractor.toJSON(),
    total_spent: totaux.total_spent,
    expenses_count: totaux.expenses_count,
    interventions_count: travaux.length,
    interventions: travaux.map((w) => ({ ...w.toJSON(), reference: `#${pad(w.number)}` })),
  };
}

async function creer(ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const contractor = await Contractor.create({ ...normaliser(donnees), owner_id: ownerId }, { transaction: t });
    await journaliser({ action: 'artisan.creation', entityType: 'contractor', entityId: contractor.id, ownerId, details: { name: contractor.name, trade: contractor.trade } }, t);
    return contractor;
  });
}

async function modifier(id, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const contractor = await chargerPourProprietaire(Contractor, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Artisan');
    const propre = normaliser(donnees);
    const avant = contractor.toJSON();
    await contractor.update(propre, { transaction: t, fields: CHAMPS });
    await journaliser({ action: 'artisan.modification', entityType: 'contractor', entityId: id, ownerId, details: difference(avant, propre, CHAMPS) }, t);
    return contractor;
  });
}

/**
 * Activation / désactivation : un artisan désactivé n'est plus proposé à
 * l'affectation de nouveaux travaux, mais reste lié à son historique.
 */
async function definirActivite(id, ownerId, actif) {
  return sequelize.transaction(async (t) => {
    const contractor = await chargerPourProprietaire(Contractor, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Artisan');
    if (contractor.is_active === actif) {
      throw new ConflictError(`Cet artisan est déjà ${actif ? 'actif' : 'désactivé'}.`, actif ? 'ARTISAN_DEJA_ACTIF' : 'ARTISAN_DEJA_INACTIF');
    }
    await contractor.update({ is_active: actif }, { transaction: t });
    await journaliser({ action: 'artisan.changement_statut', entityType: 'contractor', entityId: id, ownerId, details: { avant: !actif, apres: actif } }, t);
    return contractor;
  });
}

/**
 * Suppression LOGIQUE (§ 42) : refusée tant que l'artisan intervient sur des
 * travaux en cours — on ne retire pas l'intervenant d'un chantier ouvert.
 */
async function supprimer(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const contractor = await chargerPourProprietaire(Contractor, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Artisan');
    const enCours = await WorkOrder.count({ where: { contractor_id: id, status: STATUTS_EN_COURS }, transaction: t });
    if (enCours > 0) {
      throw new ConflictError(`Cet artisan intervient sur ${enCours} travail(aux) en cours : terminez-les ou changez d'artisan d'abord.`, 'ARTISAN_TRAVAUX_EN_COURS');
    }
    await contractor.destroy({ transaction: t });
    await journaliser({ action: 'artisan.suppression', entityType: 'contractor', entityId: id, ownerId, details: { name: contractor.name } }, t);
  });
}

module.exports = { lister, detail, creer, modifier, definirActivite, supprimer };
