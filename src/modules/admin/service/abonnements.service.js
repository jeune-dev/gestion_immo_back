'use strict';

const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { Subscription, SubscriptionPlan, SubscriptionPayment, Owner } = require('../../../models/index.js');
const { NotFoundError, ConflictError } = require('../../../errors/AppError.js');
const { ordre, periode } = require('../../../utils/liste.js');
const { aujourdhui, ajouterMois, debutMois } = require('../../../utils/dates.js');
const droits = require('../../abonnement/service/droits.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const { notifier, destinatairesProprietaire } = require('../../notification/service/notification.service.js');

/**
 * Abonnements et paiements vus par le Super Admin (§ 30 « Abonnements »,
 * « Paiements », § 31).
 *
 * Toute transition d'un abonnement invalide le cache des droits du
 * propriétaire : la garde d'écriture de l'espace propriétaire applique le
 * nouvel état dès la requête suivante, sans attendre l'expiration du cache.
 */

const INCLUDE_PLAN = { model: SubscriptionPlan, as: 'plan', attributes: ['id', 'code', 'name', 'price', 'billing_period'] };
const INCLUDE_OWNER = { model: Owner, as: 'owner', attributes: ['id', 'display_name', 'phone', 'email', 'status'], paranoid: false };

// ── Abonnements ────────────────────────────────────────────────────────────

async function lister(filtres, { limit, offset }) {
  const where = {};
  if (filtres.status) where.status = filtres.status;
  if (filtres.owner_id) where.owner_id = filtres.owner_id;
  if (filtres.fin_avant) where.current_period_end = { [Op.lte]: filtres.fin_avant };
  const plan = filtres.plan ? { ...INCLUDE_PLAN, where: { code: filtres.plan }, required: true } : INCLUDE_PLAN;
  return Subscription.findAndCountAll({
    where,
    include: [plan, INCLUDE_OWNER],
    order: ordre(filtres.tri, '-created_at'),
    limit,
    offset,
  });
}

async function charger(id, options = {}) {
  const abonnement = await Subscription.findByPk(id, options);
  if (!abonnement) throw new NotFoundError('Abonnement introuvable');
  return abonnement;
}

async function detail(id) {
  const abonnement = await charger(id, { include: [INCLUDE_PLAN, INCLUDE_OWNER] });
  const paiements = await SubscriptionPayment.findAll({
    where: { subscription_id: id },
    attributes: { exclude: ['raw_payload'] },
    include: [{ model: SubscriptionPlan, as: 'plan', attributes: ['id', 'code', 'name'] }],
    order: [['created_at', 'DESC']],
  });
  return { ...abonnement.toJSON(), payments: paiements };
}

/**
 * Transition d'un abonnement, verrouillée et journalisée ; le propriétaire
 * est prévenu (in-app + push).
 */
async function transition(id, { depuis, vers, champs = {}, motif = null, titre, corps }) {
  let ownerId;
  const resultat = await sequelize.transaction(async (t) => {
    const abonnement = await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!depuis.includes(abonnement.status)) {
      throw new ConflictError(
        `Transition impossible : l'abonnement est « ${abonnement.status} ».`,
        'TRANSITION_INTERDITE',
        { statut: abonnement.status, attendu: depuis }
      );
    }
    ownerId = abonnement.owner_id;
    const avant = abonnement.status;
    const statut = typeof vers === 'function' ? vers(abonnement) : vers;
    await abonnement.update({ ...champs, status: statut }, { transaction: t });
    await journaliser({
      action: 'abonnement.changement_statut', entityType: 'subscription', entityId: id, ownerId,
      details: { de: avant, a: statut, motif },
    }, t);
    await notifier(t, {
      destinataires: await destinatairesProprietaire(ownerId, t),
      ownerId,
      type: 'abonnement',
      titre,
      corps,
      donnees: { subscription_id: id },
    });
    return abonnement;
  });
  await droits.invalider(ownerId);
  return resultat;
}

/** Suspension (impayé contesté, abus…) : l'espace passe en lecture seule. */
function suspendre(id, { reason }) {
  return transition(id, {
    depuis: ['essai', 'actif'],
    vers: 'suspendu',
    champs: { suspended_reason: reason },
    motif: reason,
    titre: 'Abonnement suspendu',
    corps: `Votre abonnement a été suspendu par l'administrateur : ${reason}. Votre espace est en lecture seule.`,
  });
}

/**
 * Levée de la suspension. Le statut antérieur n'est pas stocké : une période
 * qui ne dépasse pas la fin d'essai était un essai, sinon un abonnement payé.
 */
function reactiver(id) {
  return transition(id, {
    depuis: ['suspendu'],
    vers: (a) => (a.trial_ends_at && a.current_period_end <= a.trial_ends_at ? 'essai' : 'actif'),
    champs: { suspended_reason: null },
    titre: 'Abonnement rétabli',
    corps: 'La suspension de votre abonnement a été levée.',
  });
}

/**
 * Annulation : l'abonnement sort de l'état « courant » (index unique partiel),
 * un nouveau paiement en créera un nouveau. Rien n'est supprimé.
 */
function annuler(id, { reason = null } = {}) {
  return transition(id, {
    depuis: ['essai', 'actif', 'suspendu'],
    vers: 'annule',
    champs: { cancelled_at: new Date() },
    motif: reason,
    titre: 'Abonnement annulé',
    corps: 'Votre abonnement a été annulé. Votre espace est en lecture seule jusqu’à une nouvelle souscription.',
  });
}

// ── Paiements ──────────────────────────────────────────────────────────────

async function listerPaiements(filtres, { limit, offset }) {
  const where = {};
  if (filtres.status) where.status = filtres.status;
  if (filtres.provider) where.provider = filtres.provider;
  if (filtres.owner_id) where.owner_id = filtres.owner_id;
  if (filtres.du || filtres.au) {
    where.created_at = periode(
      filtres.du ? new Date(`${filtres.du}T00:00:00Z`) : null,
      filtres.au ? new Date(`${filtres.au}T23:59:59.999Z`) : null
    );
  }
  return SubscriptionPayment.findAndCountAll({
    where,
    attributes: { exclude: ['raw_payload'] },
    include: [{ model: SubscriptionPlan, as: 'plan', attributes: ['id', 'code', 'name'] }, INCLUDE_OWNER],
    order: ordre(filtres.tri, '-created_at'),
    limit,
    offset,
  });
}

/**
 * Statistiques des paiements de LOYERS de toute la plateforme (§ 29
 * « Paiements ») — agrégats seulement : aucune ligne, aucun locataire, aucun
 * montant individuel ne sort de cette route.
 * Période par défaut : les 12 derniers mois.
 */
async function statistiquesLoyers({ du, au }) {
  const fin = au || aujourdhui();
  const debut = du || debutMois(ajouterMois(fin, -11));
  const replacements = { debut, fin, debutTs: new Date(`${debut}T00:00:00Z`), finTs: new Date(`${fin}T23:59:59.999Z`) };
  const [parMois, transactions] = await Promise.all([
    sequelize.query(
      `SELECT to_char(paid_on, 'YYYY-MM') AS mois, method, count(*)::int AS nombre, coalesce(sum(amount), 0) AS montant
         FROM rent_payments
        WHERE status = 'valide' AND paid_on BETWEEN :debut AND :fin
        GROUP BY 1, 2 ORDER BY 1, 2`,
      { replacements, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT status, provider, count(*)::int AS nombre, coalesce(sum(amount), 0) AS montant
         FROM payment_transactions
        WHERE created_at BETWEEN :debutTs AND :finTs
        GROUP BY 1, 2 ORDER BY 1, 2`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);

  const mois = new Map();
  const parMethode = {};
  for (const l of parMois) {
    const m = mois.get(l.mois) || { month: l.mois, count: 0, amount: 0, by_method: {} };
    m.count += l.nombre;
    m.amount += Number(l.montant);
    m.by_method[l.method] = { count: l.nombre, amount: Number(l.montant) };
    mois.set(l.mois, m);
    parMethode[l.method] = parMethode[l.method] || { count: 0, amount: 0 };
    parMethode[l.method].count += l.nombre;
    parMethode[l.method].amount += Number(l.montant);
  }
  return {
    period: { start: debut, end: fin },
    rent_payments: {
      by_month: [...mois.values()],
      by_method: parMethode,
    },
    transactions: transactions.map((l) => ({ status: l.status, provider: l.provider, count: l.nombre, amount: Number(l.montant) })),
  };
}

module.exports = {
  lister, detail, suspendre, reactiver, annuler, listerPaiements, statistiquesLoyers,
};
