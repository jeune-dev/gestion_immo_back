'use strict';

const { Op } = require('sequelize');
const { Subscription, SubscriptionPlan, Building, Apartment, MessageDelivery, Owner } = require('../../../models/index.js');
const { PaymentRequiredError, ForbiddenError } = require('../../../errors/AppError.js');
const { aujourdhui, debutMois } = require('../../../utils/dates.js');
const cache = require('../../../utils/cache.js');

/**
 * Droits d'un propriétaire selon son abonnement (§ 31) : état, limites
 * (immeubles, appartements, envois WhatsApp) et fonctionnalités du plan.
 *
 * Abonnement échu ou suspendu : l'espace passe en LECTURE SEULE — le
 * propriétaire consulte toujours ses données (financières notamment) mais ne
 * peut plus rien créer ni modifier tant qu'il n'a pas renouvelé.
 */

const TTL_S = 30;
const cleCache = (ownerId) => `abonnement:${ownerId}`;

/**
 * @returns {Promise<{ abonnement: object|null, plan: object|null, actif: boolean }>}
 */
async function etat(ownerId) {
  const enCache = await cache.lire(cleCache(ownerId));
  if (enCache) return enCache;

  const abonnement = await Subscription.findOne({
    where: { owner_id: ownerId, status: { [Op.in]: ['essai', 'actif', 'suspendu'] } },
    include: [{ model: SubscriptionPlan, as: 'plan' }],
  });
  const jour = aujourdhui();
  const actif = Boolean(abonnement)
    && ['essai', 'actif'].includes(abonnement.status)
    && abonnement.current_period_end >= jour;

  const resultat = {
    abonnement: abonnement ? {
      id: abonnement.id,
      status: abonnement.status,
      current_period_end: abonnement.current_period_end,
      trial_ends_at: abonnement.trial_ends_at,
    } : null,
    plan: abonnement?.plan ? {
      code: abonnement.plan.code,
      name: abonnement.plan.name,
      max_buildings: abonnement.plan.max_buildings,
      max_apartments: abonnement.plan.max_apartments,
      max_whatsapp_per_month: abonnement.plan.max_whatsapp_per_month,
      features: abonnement.plan.features,
    } : null,
    actif,
  };
  await cache.ecrire(cleCache(ownerId), resultat, TTL_S);
  return resultat;
}

async function invalider(ownerId) {
  await cache.invalider(cleCache(ownerId));
}

function exigerActif(droits) {
  if (!droits.actif) {
    throw new PaymentRequiredError(
      'Votre abonnement est expiré ou suspendu : votre espace est en lecture seule. Renouvelez-le pour continuer.',
      'ABONNEMENT_REQUIS',
      { abonnement: droits.abonnement }
    );
  }
}

/**
 * Vérifie une limite quantitative AVANT une création (dans la transaction de
 * la création, pour que deux créations simultanées ne dépassent pas ensemble).
 * @param {'buildings'|'apartments'} ressource
 */
async function verifierLimite(ownerId, ressource, transaction) {
  const droits = await etat(ownerId);
  exigerActif(droits);
  const max = ressource === 'buildings' ? droits.plan?.max_buildings : droits.plan?.max_apartments;
  if (max === null || max === undefined) return;
  // Verrou sur la ligne du propriétaire : deux créations simultanées sont
  // sérialisées, elles ne peuvent pas franchir la limite ensemble.
  if (transaction) await Owner.findByPk(ownerId, { attributes: ['id'], lock: transaction.LOCK.UPDATE, transaction });
  const Modele = ressource === 'buildings' ? Building : Apartment;
  const nombre = await Modele.count({ where: { owner_id: ownerId }, transaction });
  if (nombre >= max) {
    const libelle = ressource === 'buildings' ? "d'immeubles" : "d'appartements";
    throw new ForbiddenError(
      `Limite de votre formule atteinte (${max} ${libelle}). Passez à une formule supérieure.`,
      'LIMITE_ABONNEMENT',
      { ressource, max }
    );
  }
}

async function aFonctionnalite(ownerId, code) {
  const droits = await etat(ownerId);
  return droits.actif && Boolean(droits.plan?.features?.includes(code));
}

/**
 * Fonctionnalités du DERNIER abonnement, quel que soit son statut (expiré,
 * annulé) : un espace échu reste consultable avec ce que sa formule incluait.
 * Lu seulement quand il n'y a plus d'abonnement courant (cas rare, non mis en
 * cache).
 */
async function fonctionnalitesDuDernierPlan(ownerId) {
  const dernier = await Subscription.findOne({
    where: { owner_id: ownerId },
    include: [{ model: SubscriptionPlan, as: 'plan', attributes: ['features'] }],
    order: [['created_at', 'DESC'], ['id', 'DESC']],
  });
  return dernier?.plan ? dernier.plan.features || [] : null;
}

/**
 * La fonctionnalité doit être incluse dans la formule.
 *   - ÉCRITURE : abonnement actif exigé (402 sinon) ;
 *   - LECTURE (`lecture: true`) : § 31, un abonnement échu ou suspendu laisse
 *     l'espace en lecture seule — seule l'inclusion dans la formule compte
 *     (celle du dernier abonnement s'il n'y en a plus de courant). Sans aucun
 *     abonnement connu, 402 comme pour une écriture.
 */
async function exigerFonctionnalite(ownerId, code, { lecture = false } = {}) {
  const droits = await etat(ownerId);
  let fonctionnalites = droits.plan?.features;
  if (lecture) {
    if (!fonctionnalites) fonctionnalites = await fonctionnalitesDuDernierPlan(ownerId);
    if (!fonctionnalites) exigerActif(droits);
  } else {
    exigerActif(droits);
  }
  if (!fonctionnalites?.includes(code)) {
    throw new ForbiddenError("Cette fonctionnalité n'est pas incluse dans votre formule.", 'FONCTIONNALITE_NON_INCLUSE', { fonctionnalite: code });
  }
}

/** Reste-t-il du quota WhatsApp ce mois-ci ? (§ 54.3 « limités par plan ») */
async function quotaWhatsappDisponible(ownerId) {
  const droits = await etat(ownerId);
  if (!droits.actif || !droits.plan?.features?.includes('relances_whatsapp')) return false;
  const max = droits.plan.max_whatsapp_per_month;
  if (max === null || max === undefined) return true;
  const envoyes = await MessageDelivery.count({
    where: {
      owner_id: ownerId,
      channel: 'whatsapp',
      status: { [Op.notIn]: ['echec', 'ignore'] },
      created_at: { [Op.gte]: new Date(`${debutMois(aujourdhui())}T00:00:00Z`) },
    },
  });
  return envoyes < max;
}

module.exports = { etat, invalider, exigerActif, verifierLimite, aFonctionnalite, exigerFonctionnalite, quotaWhatsappDisponible };
