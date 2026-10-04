'use strict';

const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  PlatformSetting, SubscriptionPlan, ExpenseCategory, Role, AuditLog,
} = require('../../../models/index.js');
const { DEFAUTS_PLATEFORME, SCHEMAS_PLATEFORME } = require('../../../config/parametres.js');
const { TOUTES } = require('../../../config/permissions.js');
const { NotFoundError, ConflictError, ValidationError } = require('../../../errors/AppError.js');
const escapeLike = require('../../../utils/escapeLike.js');
const { invaliderPlateforme } = require('../../parametres/service/parametres.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Réglages transverses de la plateforme (§ 30 « Paramètres »,
 * « Notifications », « Catégories »), journal d'audit (§ 40) et rôles (§ 32).
 */

// ── Paramètres plateforme ──────────────────────────────────────────────────

/** Tous les paramètres connus : valeur effective (défauts + surcharge) et défaut. */
async function listerParametres() {
  const lignes = await PlatformSetting.findAll();
  const parCle = new Map(lignes.map((l) => [l.key, l]));
  return Object.keys(DEFAUTS_PLATEFORME).map((cle) => {
    const ligne = parCle.get(cle);
    return {
      key: cle,
      value: { ...DEFAUTS_PLATEFORME[cle], ...(ligne?.value || {}) },
      default: DEFAUTS_PLATEFORME[cle],
      customized: Boolean(ligne),
      description: ligne?.description ?? null,
      updated_by: ligne?.updated_by ?? null,
      updated_at: ligne?.updated_at ?? null,
    };
  });
}

/**
 * Modification d'un paramètre, validée par SON schéma (config/parametres.js) :
 * une clé inconnue n'existe pas (404), une valeur hors bornes est refusée
 * (422) — un réglage plateforme mal saisi toucherait tous les propriétaires.
 */
async function modifierParametre(admin, cle, corps) {
  const schema = SCHEMAS_PLATEFORME[cle];
  if (!schema) throw new NotFoundError('Paramètre inconnu');
  const { error, value } = schema.validate(corps, { abortEarly: false, stripUnknown: true, convert: true });
  if (error) throw new ValidationError('Données invalides', error.details.map((d) => d.message));
  if (cle === 'essai') {
    const plan = await SubscriptionPlan.findOne({ where: { code: value.plan_code, status: 'actif' }, attributes: ['id'] });
    if (!plan) throw new ValidationError('Données invalides', ["La formule d'essai doit être une formule active"], 'PLAN_INDISPONIBLE');
  }

  await sequelize.transaction(async (t) => {
    const existant = await PlatformSetting.findByPk(cle, { transaction: t, lock: t.LOCK.UPDATE });
    const avant = { ...DEFAUTS_PLATEFORME[cle], ...(existant?.value || {}) };
    if (existant) await existant.update({ value, updated_by: admin.id }, { transaction: t });
    else await PlatformSetting.create({ key: cle, value, updated_by: admin.id }, { transaction: t });
    await journaliser({
      action: 'parametre_plateforme.modification', entityType: 'platform_setting', entityId: cle,
      details: difference(avant, value, Object.keys(value)),
    }, t);
  });
  await invaliderPlateforme(cle);
  return (await listerParametres()).find((p) => p.key === cle);
}

// ── Notifications diffusées ────────────────────────────────────────────────

const ROLES_CIBLES = Object.freeze({
  proprietaires: ['proprietaire'],
  locataires: ['locataire'],
  tous: ['proprietaire', 'locataire'],
});

/**
 * Message d'information à tous les comptes actifs d'une population (§ 30
 * « Notifications »). UN seul INSERT … SELECT écrit toutes les notifications
 * en base : aucune boucle applicative, quel que soit le nombre de comptes.
 *
 * Diffusion INTERNE uniquement (centre de notifications de l'application) :
 * un envoi push à des dizaines de milliers d'appareils ferait une requête FCM
 * par appareil depuis le processus API — coût, quotas Firebase et latence
 * sans commune mesure avec une information non urgente, que chacun lira à sa
 * prochaine ouverture de l'application.
 */
async function diffuser({ cible, titre, corps }) {
  return sequelize.transaction(async (t) => {
    const [{ nombre }] = await sequelize.query(
      `WITH inseres AS (
         INSERT INTO notifications (user_id, owner_id, type, title, body, data)
         SELECT u.id, NULL, 'systeme', :titre, :corps, jsonb_build_object('diffusion', true, 'cible', CAST(:cible AS text))
           FROM users u
          WHERE u.deleted_at IS NULL AND u.status = 'actif' AND u.role_code IN (:roles)
         RETURNING 1
       )
       SELECT count(*)::int AS nombre FROM inseres`,
      { replacements: { titre, corps, cible, roles: ROLES_CIBLES[cible] }, type: QueryTypes.SELECT, transaction: t }
    );
    await journaliser({
      action: 'admin.notification_diffusion', entityType: 'notification',
      details: { cible, titre, corps, destinataires: nombre },
    }, t);
    return { cible, destinataires: nombre };
  });
}

async function historiqueDiffusions({ limit, offset }) {
  return AuditLog.findAndCountAll({
    where: { action: 'admin.notification_diffusion' },
    attributes: ['id', 'user_id', 'details', 'created_at'],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });
}

// ── Catégories de dépenses globales ────────────────────────────────────────

/**
 * Catégories GLOBALES (owner_id NULL), proposées à tous les propriétaires
 * (§ 20). Les catégories personnelles d'un propriétaire ne sont pas
 * administrables ici : elles lui appartiennent (404 hors périmètre).
 */
const USAGE = [sequelize.literal('(SELECT count(*)::int FROM expenses e WHERE e.category_id = "ExpenseCategory"."id")'), 'expenses_count'];

async function listerCategories(filtres) {
  const where = { owner_id: null };
  if (filtres.is_active !== undefined) where.is_active = filtres.is_active;
  return ExpenseCategory.findAll({
    where,
    attributes: { include: [USAGE] },
    order: [['sort_order', 'ASC'], ['name', 'ASC']],
  });
}

async function chargerCategorie(id, options = {}) {
  const categorie = await ExpenseCategory.findOne({ where: { id, owner_id: null }, ...options });
  if (!categorie) throw new NotFoundError('Catégorie introuvable');
  return categorie;
}

async function creerCategorie(donnees) {
  const existe = await ExpenseCategory.findOne({ where: { owner_id: null, code: donnees.code }, attributes: ['id'] });
  if (existe) throw new ConflictError('Ce code de catégorie existe déjà.', 'CODE_UTILISE');
  return sequelize.transaction(async (t) => {
    const categorie = await ExpenseCategory.create({ ...donnees, owner_id: null }, { transaction: t });
    await journaliser({
      action: 'categorie_depense.creation', entityType: 'expense_category', entityId: categorie.id,
      details: { code: categorie.code, name: categorie.name, cash_group: categorie.cash_group },
    }, t);
    return categorie;
  });
}

const CHAMPS_CATEGORIE = ['name', 'cash_group', 'sort_order'];

async function modifierCategorie(id, donnees) {
  return sequelize.transaction(async (t) => {
    const categorie = await chargerCategorie(id, { transaction: t, lock: t.LOCK.UPDATE });
    const avant = categorie.toJSON();
    await categorie.update(donnees, { transaction: t, fields: CHAMPS_CATEGORIE });
    await journaliser({
      action: 'categorie_depense.modification', entityType: 'expense_category', entityId: id,
      details: difference(avant, donnees, CHAMPS_CATEGORIE),
    }, t);
    return categorie;
  });
}

/** Désactivation : la catégorie n'est plus proposée, les dépenses passées la gardent. */
async function changerActivationCategorie(id, actif) {
  return sequelize.transaction(async (t) => {
    const categorie = await chargerCategorie(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (categorie.is_active === actif) {
      throw new ConflictError(actif ? 'Cette catégorie est déjà active.' : 'Cette catégorie est déjà désactivée.', 'STATUT_INCHANGE');
    }
    await categorie.update({ is_active: actif }, { transaction: t });
    await journaliser({
      action: 'categorie_depense.changement_statut', entityType: 'expense_category', entityId: id,
      details: { is_active: actif },
    }, t);
    return categorie;
  });
}

/** Suppression réservée à une catégorie JAMAIS utilisée (sinon : désactivation, § 42). */
async function supprimerCategorie(id) {
  return sequelize.transaction(async (t) => {
    const categorie = await chargerCategorie(id, { transaction: t, lock: t.LOCK.UPDATE });
    const [{ nombre }] = await sequelize.query(
      'SELECT count(*)::int AS nombre FROM expenses WHERE category_id = :id',
      { replacements: { id }, type: QueryTypes.SELECT, transaction: t }
    );
    if (nombre > 0) {
      throw new ConflictError(`Catégorie utilisée par ${nombre} dépense(s) : désactivez-la plutôt.`, 'CATEGORIE_UTILISEE');
    }
    await categorie.destroy({ transaction: t });
    await journaliser({
      action: 'categorie_depense.suppression', entityType: 'expense_category', entityId: id,
      details: { code: categorie.code, name: categorie.name },
    }, t);
  });
}

// ── Journal d'audit ────────────────────────────────────────────────────────

/** Consultation du journal (§ 40 « qui a fait quoi, quand, sur quelle donnée »), du plus récent au plus ancien. */
async function journal(filtres, { limit, offset }) {
  const where = {};
  if (filtres.owner_id) where.owner_id = filtres.owner_id;
  if (filtres.user_id) where.user_id = filtres.user_id;
  if (filtres.entity_type) where.entity_type = filtres.entity_type;
  if (filtres.entity_id) where.entity_id = filtres.entity_id;
  if (filtres.action) where.action = { [Op.like]: `${escapeLike(filtres.action)}%` };
  if (filtres.du || filtres.au) {
    where.created_at = {};
    if (filtres.du) where.created_at[Op.gte] = new Date(`${filtres.du}T00:00:00Z`);
    if (filtres.au) where.created_at[Op.lte] = new Date(`${filtres.au}T23:59:59.999Z`);
  }
  return AuditLog.findAndCountAll({
    where,
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });
}

// ── Rôles ──────────────────────────────────────────────────────────────────

/**
 * Rôles et permissions, en LECTURE SEULE : les rôles système sont
 * resynchronisés depuis le code (config/permissions.js) à chaque démarrage par
 * src/scripts/initialiser.js. Une modification faite ici serait écrasée au
 * déploiement suivant — l'évolution des droits passe par le code, revu et
 * testé, jamais par une saisie en production.
 */
async function roles() {
  const liste = await Role.findAll({ order: [['code', 'ASC']] });
  return { roles: liste, catalogue: TOUTES };
}

module.exports = {
  listerParametres, modifierParametre, diffuser, historiqueDiffusions,
  listerCategories, creerCategorie, modifierCategorie, changerActivationCategorie, supprimerCategorie,
  journal, roles, ROLES_CIBLES,
};
