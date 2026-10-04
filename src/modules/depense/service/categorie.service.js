'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { ExpenseCategory } = require('../../../models/index.js');
const { NotFoundError, ForbiddenError, ConflictError, ValidationError } = require('../../../errors/AppError.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Catégories de dépenses (§ 20, § 21).
 *
 * Deux niveaux :
 *   - catégories GLOBALES (`owner_id` NULL), administrées par le Super Admin
 *     (§ 30) : en LECTURE SEULE pour un propriétaire (403) ;
 *   - catégories PROPRES à un propriétaire, qu'il crée, renomme et désactive.
 * Chaque catégorie est rangée dans un groupe de sorties de caisse du § 21 :
 * c'est ce groupe qui classe le mouvement de caisse de la dépense.
 */

const CHAMPS = ['name', 'cash_group', 'sort_order'];

/** « Réparation toiture » → « reparation_toiture » (code stable, sans accent). */
function slug(texte) {
  return String(texte)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

const versApi = (c) => ({ ...c.toJSON(), is_global: c.owner_id === null });

async function lister(ownerId, { inclure_inactives: inclureInactives = false } = {}) {
  const where = { [Op.or]: [{ owner_id: null }, { owner_id: ownerId }] };
  if (!inclureInactives) where.is_active = true;
  const lignes = await ExpenseCategory.findAll({ where, order: [['sort_order', 'ASC'], ['name', 'ASC'], ['id', 'ASC']] });
  return lignes.map(versApi);
}

/**
 * Charge une catégorie PROPRE au propriétaire pour la modifier : une
 * catégorie globale est refusée (403) — elle est partagée par tous les
 * espaces et relève du Super Admin.
 */
async function chargerPropre(id, ownerId, t) {
  const categorie = await ExpenseCategory.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!categorie) throw new NotFoundError('Catégorie introuvable');
  if (categorie.owner_id === null) {
    throw new ForbiddenError('Les catégories de la plateforme ne sont pas modifiables. Créez votre propre catégorie.', 'CATEGORIE_GLOBALE');
  }
  if (categorie.owner_id !== ownerId) throw new ForbiddenError("Vous n'avez pas accès à cette ressource.", 'ACCES_AUTRE_PROPRIETAIRE');
  return categorie;
}

/**
 * Catégorie utilisable pour une dépense : globale ou propre, et active.
 * Une référence invalide est une donnée invalide (422), une catégorie d'un
 * autre propriétaire un accès refusé (403).
 */
async function resoudre(id, ownerId, t) {
  const categorie = await ExpenseCategory.findByPk(id, { transaction: t });
  if (!categorie) throw new ValidationError('Données invalides', ['Catégorie de dépense introuvable']);
  if (categorie.owner_id !== null && categorie.owner_id !== ownerId) {
    throw new ForbiddenError("Vous n'avez pas accès à cette ressource.", 'ACCES_AUTRE_PROPRIETAIRE');
  }
  if (!categorie.is_active) throw new ValidationError('Données invalides', ['Cette catégorie de dépense est désactivée']);
  return categorie;
}

/** Catégorie globale par son code (« travaux » pour la dépense d'un chantier). */
async function globaleParCode(code, t) {
  const categorie = await ExpenseCategory.findOne({ where: { owner_id: null, code, is_active: true }, transaction: t });
  if (!categorie) throw new ValidationError('Données invalides', [`Catégorie « ${code} » indisponible : précisez category_id`]);
  return categorie;
}

async function creer(ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const code = donnees.code || slug(donnees.name);
    if (!code) throw new ValidationError('Données invalides', ['Le nom doit contenir au moins une lettre ou un chiffre']);
    // Un code déjà pris — dans l'espace ou par une catégorie globale — rendrait
    // les rapports ambigus (deux « travaux » différents).
    const existante = await ExpenseCategory.findOne({
      where: { code, [Op.or]: [{ owner_id: null }, { owner_id: ownerId }] },
      transaction: t,
    });
    if (existante) throw new ConflictError(`Une catégorie « ${code} » existe déjà.`, 'CATEGORIE_EXISTANTE');
    const categorie = await ExpenseCategory.create({ ...donnees, code, owner_id: ownerId }, { transaction: t });
    await journaliser({ action: 'categorie_depense.creation', entityType: 'expense_category', entityId: categorie.id, ownerId, details: { code, name: categorie.name, cash_group: categorie.cash_group } }, t);
    return versApi(categorie);
  });
}

async function modifier(id, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const categorie = await chargerPropre(id, ownerId, t);
    const avant = categorie.toJSON();
    await categorie.update(donnees, { transaction: t, fields: CHAMPS });
    await journaliser({ action: 'categorie_depense.modification', entityType: 'expense_category', entityId: id, ownerId, details: difference(avant, donnees, CHAMPS) }, t);
    return versApi(categorie);
  });
}

/**
 * Désactivation plutôt que suppression (§ 42) : les dépenses passées gardent
 * leur catégorie, qui n'est simplement plus proposée à la saisie.
 */
async function desactiver(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const categorie = await chargerPropre(id, ownerId, t);
    if (!categorie.is_active) throw new ConflictError('Catégorie déjà désactivée.', 'CATEGORIE_DEJA_INACTIVE');
    await categorie.update({ is_active: false }, { transaction: t });
    await journaliser({ action: 'categorie_depense.changement_statut', entityType: 'expense_category', entityId: id, ownerId, details: { avant: 'active', apres: 'inactive' } }, t);
    return versApi(categorie);
  });
}

module.exports = { lister, creer, modifier, desactiver, resoudre, globaleParCode, slug };
