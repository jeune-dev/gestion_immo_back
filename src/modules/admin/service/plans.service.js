'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { SubscriptionPlan } = require('../../../models/index.js');
const { NotFoundError, ConflictError } = require('../../../errors/AppError.js');
const cache = require('../../../utils/cache.js');
const parametres = require('../../parametres/service/parametres.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Plans tarifaires (§ 31) : « plan, prix, période, nombre maximum d'immeubles,
 * nombre maximum d'appartements, fonctionnalités, statut » — et « les prix
 * doivent être configurables depuis le Super Admin, pas codés en dur ».
 *
 * Une modification de plan change les droits de TOUS ses abonnés : le cache
 * `abonnement:*` (droits de chaque propriétaire et formules publiques) est
 * invalidé après chaque écriture.
 */

const CHAMPS = [
  'name', 'description', 'price', 'currency', 'billing_period', 'max_buildings', 'max_apartments',
  'max_whatsapp_per_month', 'features', 'sort_order',
];

const ABONNES = [
  sequelize.literal("(SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = \"SubscriptionPlan\".\"id\" AND s.status IN ('essai', 'actif', 'suspendu'))"),
  'subscribers_count',
];

const invaliderDroits = () => cache.invalider('abonnement:*');

async function lister(filtres) {
  const where = {};
  if (filtres.status) where.status = filtres.status;
  return SubscriptionPlan.findAll({
    where,
    attributes: { include: [ABONNES] },
    order: [['sort_order', 'ASC'], ['name', 'ASC']],
  });
}

async function charger(id, options = {}) {
  const plan = await SubscriptionPlan.findByPk(id, options);
  if (!plan) throw new NotFoundError('Plan introuvable');
  return plan;
}

const detail = (id) => charger(id, { attributes: { include: [ABONNES] } });

async function creer(donnees) {
  const existe = await SubscriptionPlan.findOne({ where: { code: donnees.code }, attributes: ['id'] });
  if (existe) throw new ConflictError('Ce code de plan existe déjà.', 'CODE_UTILISE');
  const plan = await sequelize.transaction(async (t) => {
    const cree = await SubscriptionPlan.create(donnees, { transaction: t });
    await journaliser({
      action: 'plan.creation', entityType: 'subscription_plan', entityId: cree.id,
      details: { code: cree.code, price: Number(cree.price), features: cree.features },
    }, t);
    return cree;
  });
  await invaliderDroits();
  return plan;
}

async function modifier(id, donnees) {
  const plan = await sequelize.transaction(async (t) => {
    const existant = await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    const avant = { ...existant.toJSON(), price: Number(existant.price) };
    await existant.update(donnees, { transaction: t, fields: CHAMPS });
    await journaliser({
      action: 'plan.modification', entityType: 'subscription_plan', entityId: id,
      details: { code: existant.code, ...difference(avant, donnees, CHAMPS) },
    }, t);
    return existant;
  });
  await invaliderDroits();
  return plan;
}

/**
 * Le plan d'essai en vigueur (paramètre plateforme « essai ») ne peut être ni
 * désactivé ni supprimé : les nouvelles inscriptions se feraient sans
 * abonnement.
 */
async function refuserSiPlanEssai(plan) {
  const essai = await parametres.plateforme('essai');
  if (essai.plan_code === plan.code) {
    throw new ConflictError("Ce plan est la formule d'essai des nouvelles inscriptions : changez d'abord le paramètre « essai ».", 'PLAN_ESSAI');
  }
}

/**
 * Activation / désactivation. Un plan désactivé n'est plus proposé à la
 * souscription ; ses abonnés en cours le conservent jusqu'à leur échéance.
 * Le plan d'essai en vigueur ne peut pas être désactivé : les inscriptions se
 * feraient sans abonnement.
 */
async function changerStatut(id, statut) {
  const plan = await sequelize.transaction(async (t) => {
    const existant = await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (existant.status === statut) throw new ConflictError(`Ce plan est déjà ${statut}.`, 'STATUT_INCHANGE');
    if (statut === 'inactif') await refuserSiPlanEssai(existant);
    await existant.update({ status: statut }, { transaction: t });
    await journaliser({
      action: 'plan.changement_statut', entityType: 'subscription_plan', entityId: id,
      details: { code: existant.code, statut },
    }, t);
    return existant;
  });
  await invaliderDroits();
  return plan;
}

/**
 * Suppression d'un plan jamais souscrit (créé par erreur). Dès qu'un
 * abonnement ou un paiement le référence, il fait partie de l'historique
 * financier : on le désactive, on ne le supprime pas (§ 42).
 */
async function supprimer(id) {
  await sequelize.transaction(async (t) => {
    const plan = await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    // CORRECTIF : même garde que la désactivation (un plan d'essai tout juste
    // créé, sans abonné, était supprimable).
    await refuserSiPlanEssai(plan);
    const [{ nombre }] = await sequelize.query(
      `SELECT (SELECT count(*) FROM subscriptions WHERE plan_id = :id)
            + (SELECT count(*) FROM subscription_payments WHERE plan_id = :id) AS nombre`,
      { replacements: { id }, type: QueryTypes.SELECT, transaction: t }
    );
    if (Number(nombre) > 0) {
      throw new ConflictError('Ce plan est référencé par des abonnements ou des paiements : désactivez-le plutôt.', 'PLAN_UTILISE');
    }
    await plan.destroy({ transaction: t });
    await journaliser({ action: 'plan.suppression', entityType: 'subscription_plan', entityId: id, details: { code: plan.code } }, t);
  });
  await invaliderDroits();
}

module.exports = { lister, detail, creer, modifier, changerStatut, supprimer };
