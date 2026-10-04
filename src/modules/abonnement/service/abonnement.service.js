'use strict';

const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Subscription, SubscriptionPlan, SubscriptionPayment, Owner, OwnerMember, AuditLog,
} = require('../../../models/index.js');
const { FONCTIONNALITE } = require('../../../config/enums.js');
const {
  AppError, ConflictError, NotFoundError, ValidationError, ServiceIndisponibleError,
} = require('../../../errors/AppError.js');
const paydunya = require('../../../infrastructure/paiement/paydunya.provider.js');
const { prochainNumero, pad } = require('../../../utils/compteur.js');
const { aujourdhui, ajouterMois, debutMois, compacte, formatFr } = require('../../../utils/dates.js');
const cache = require('../../../utils/cache.js');
const logger = require('../../../utils/logger.js');
const droits = require('./droits.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const { notifier, destinatairesProprietaire } = require('../../notification/service/notification.service.js');

/**
 * Abonnements SaaS (§ 31) : formules publiques, souscription et renouvellement
 * par PayDunya, activation par confirmation de paiement, expiration, activation
 * manuelle par le Super Admin.
 *
 * Contrairement aux loyers (§ 51.5 : fonds encaissés sur le compte du
 * PROPRIÉTAIRE), l'abonnement est payé à la PLATEFORME : les identifiants
 * PayDunya sont ceux de la plateforme (variables d'environnement), jamais ceux
 * d'un propriétaire.
 *
 * Un abonnement « courant » par propriétaire (index unique partiel sur
 * essai / actif / suspendu) : un renouvellement PROLONGE ou MODIFIE la ligne
 * courante ; une nouvelle ligne n'est créée que lorsqu'il n'y en a plus
 * (expirée ou annulée), ce qui conserve l'historique des périodes passées.
 */

const COURANTS = ['essai', 'actif', 'suspendu'];
const CLE_PLANS_PUBLICS = 'abonnement:plans:publics';
const TTL_PLANS_S = 300;

/**
 * Identifiants PayDunya de la PLATEFORME, lus à l'appel (rotation de clés sans
 * redémarrage de code). Noms de variables du SDK officiel PayDunya.
 */
function identifiantsPlateforme() {
  const masterKey = process.env.PAYDUNYA_MASTER_KEY;
  const privateKey = process.env.PAYDUNYA_PRIVATE_KEY;
  const token = process.env.PAYDUNYA_TOKEN;
  if (!masterKey || !privateKey || !token) return null;
  return { master_key: masterKey, private_key: privateKey, token, mode: process.env.PAYDUNYA_MODE === 'live' ? 'live' : 'test' };
}

const sansSlash = (url) => String(url).replace(/\/$/, '');

// ── Formules publiques ─────────────────────────────────────────────────────

function planVersApi(plan) {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    price: Number(plan.price),
    currency: plan.currency,
    billing_period: plan.billing_period,
    limits: {
      max_buildings: plan.max_buildings,
      max_apartments: plan.max_apartments,
      max_whatsapp_per_month: plan.max_whatsapp_per_month,
    },
    features: (plan.features || []).map((code) => ({ code, label: FONCTIONNALITE[code] || code })),
  };
}

/**
 * Formules actives, dans l'ordre d'affichage. Mises en cache sous le préfixe
 * `abonnement:` : toute modification d'un plan par le Super Admin invalide
 * `abonnement:*` et le nouveau prix est visible immédiatement (§ 31 « prix
 * configurables depuis le Super Admin »).
 */
async function plansPublics() {
  const enCache = await cache.lire(CLE_PLANS_PUBLICS);
  if (enCache) return enCache;
  const plans = await SubscriptionPlan.findAll({ where: { status: 'actif' }, order: [['sort_order', 'ASC'], ['name', 'ASC']] });
  const resultat = plans.map(planVersApi);
  await cache.ecrire(CLE_PLANS_PUBLICS, resultat, TTL_PLANS_S);
  return resultat;
}

// ── Espace propriétaire ────────────────────────────────────────────────────

/**
 * État de l'abonnement et consommation des limites du plan (§ 31, § 54.3) —
 * les trois compteurs en UNE requête.
 */
async function etatCourant(ownerId) {
  const etat = await droits.etat(ownerId);
  const [usage] = await sequelize.query(
    `SELECT
       (SELECT count(*)::int FROM buildings WHERE owner_id = :ownerId AND deleted_at IS NULL) AS buildings,
       (SELECT count(*)::int FROM apartments WHERE owner_id = :ownerId AND deleted_at IS NULL) AS apartments,
       (SELECT count(*)::int FROM message_deliveries
         WHERE owner_id = :ownerId AND channel = 'whatsapp' AND status NOT IN ('echec', 'ignore')
           AND created_at >= :debut) AS whatsapp`,
    {
      replacements: { ownerId, debut: new Date(`${debutMois(aujourdhui())}T00:00:00Z`) },
      type: QueryTypes.SELECT,
    }
  );
  return {
    ...etat,
    usage: {
      buildings: { used: usage.buildings, max: etat.plan?.max_buildings ?? null },
      apartments: { used: usage.apartments, max: etat.plan?.max_apartments ?? null },
      whatsapp_this_month: { used: usage.whatsapp, max: etat.plan?.max_whatsapp_per_month ?? null },
    },
  };
}

const ATTRIBUTS_PAIEMENT = { exclude: ['raw_payload'] };
const INCLUDE_PLAN = { model: SubscriptionPlan, as: 'plan', attributes: ['id', 'code', 'name'] };

async function historiquePaiements(ownerId, filtres, { limit, offset }) {
  const where = { owner_id: ownerId };
  if (filtres.status) where.status = filtres.status;
  return SubscriptionPayment.findAndCountAll({
    where,
    attributes: ATTRIBUTS_PAIEMENT,
    include: [INCLUDE_PLAN],
    order: [['created_at', 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
}

/** Référence lisible et unique : ABO-20260928-000042. */
async function nouvelleReference(transaction) {
  const n = await prochainNumero('plateforme:abonnement', transaction);
  return `ABO-${compacte(aujourdhui())}-${pad(n, 6)}`;
}

/**
 * Souscription ou renouvellement payé en ligne (§ 31).
 *
 * La ligne de paiement est créée AVANT l'appel à PayDunya (transaction courte,
 * jamais ouverte pendant un appel réseau) : l'IPN peut arriver avant même la
 * réponse de PayDunya, elle doit trouver sa référence. Aucun abonnement n'est
 * modifié ici — seule l'IPN, facture relue chez PayDunya, active la formule.
 */
async function souscrire(ownerId, user, { plan_code: planCode, months, wallet = null }) {
  const identifiants = identifiantsPlateforme();
  const urlApi = process.env.API_PUBLIC_URL;
  const urlApp = process.env.APP_PUBLIC_URL;
  if (!identifiants || !urlApi || !urlApp) {
    throw new ServiceIndisponibleError(
      "Le paiement en ligne des abonnements n'est pas encore disponible. Contactez le support pour activer votre formule.",
      'PAIEMENT_NON_CONFIGURE'
    );
  }
  const plan = await SubscriptionPlan.findOne({ where: { code: planCode, status: 'actif' } });
  if (!plan) throw new ValidationError('Données invalides', ['Formule inconnue ou indisponible'], 'PLAN_INDISPONIBLE');
  const montant = Number(plan.price) * months;
  if (montant <= 0) {
    throw new ConflictError("Cette formule sans frais est activée par l'administrateur, sans paiement.", 'PLAN_GRATUIT');
  }

  const paiement = await sequelize.transaction(async (t) => {
    const p = await SubscriptionPayment.create({
      owner_id: ownerId,
      plan_id: plan.id,
      amount: montant,
      currency: plan.currency,
      months,
      provider: 'paydunya',
      reference: await nouvelleReference(t),
      status: 'initie',
      recorded_by: user.id,
    }, { transaction: t });
    await journaliser({
      action: 'abonnement_paiement.creation', entityType: 'subscription_payment', entityId: p.id, ownerId,
      details: { reference: p.reference, plan: plan.code, mois: months, montant },
    }, t);
    return p;
  });

  const retour = `${sansSlash(urlApp)}/abonnement/paiement`;
  let demande;
  try {
    demande = await paydunya.demanderPaiement({
      identifiants,
      reference: paiement.reference,
      montant,
      libelle: `Abonnement ${plan.name} — ${months} mois`,
      portefeuille: wallet,
      urlIpn: `${sansSlash(urlApi)}/api/v1/webhooks/abonnement/paydunya`,
      urlSucces: `${retour}/succes?reference=${encodeURIComponent(paiement.reference)}`,
      urlAnnulation: `${retour}/annule?reference=${encodeURIComponent(paiement.reference)}`,
    });
  } catch (err) {
    // La demande n'existe pas chez PayDunya : la ligne est close, une nouvelle
    // tentative créera une nouvelle référence.
    await paiement.update({ status: 'echoue', note: `Demande refusée par PayDunya : ${err.message}`.slice(0, 500) });
    logger.warn('[abonnement] Demande de paiement PayDunya impossible', { reference: paiement.reference, error: err.message });
    if (err instanceof AppError) throw err;
    throw new ServiceIndisponibleError(
      "Le service de paiement n'a pas pu créer la demande. Réessayez dans quelques instants.",
      'PAIEMENT_INDISPONIBLE'
    );
  }
  // Le jeton de facture est l'identifiant PayDunya du paiement : il permet de
  // retrouver la ligne même si une IPN ne renvoyait pas la référence.
  await paiement.update({ checkout_url: demande.urlPaiement, provider_transaction_id: `paydunya:${demande.jeton}` });
  const payment = paiement.toJSON();
  delete payment.raw_payload;
  return { payment, checkout_url: demande.urlPaiement };
}

// ── Activation ─────────────────────────────────────────────────────────────

/**
 * Applique `mois` payés de la formule `plan` à l'abonnement du propriétaire,
 * dans la transaction du paiement :
 *   - même formule, abonnement payé en cours → la période est PROLONGÉE à
 *     partir de max(aujourd'hui, fin actuelle) : payer en avance ne fait
 *     perdre aucun jour ;
 *   - autre formule, ou sortie de la période d'essai → la nouvelle formule
 *     démarre aujourd'hui (changement de limites immédiat) ;
 *   - plus d'abonnement courant (expiré, annulé, jamais souscrit) → NOUVELLE
 *     ligne, l'ancienne reste dans l'historique.
 * Un abonnement SUSPENDU par l'administrateur reste suspendu : le paiement est
 * crédité (période) mais la levée d'une sanction relève de l'administrateur.
 */
async function appliquerPaiement(ownerId, plan, mois, t) {
  const jour = aujourdhui();
  // Verrou sur le propriétaire : deux confirmations simultanées (IPN + activation
  // manuelle) sont sérialisées et ne créent jamais deux abonnements courants.
  await Owner.findByPk(ownerId, { attributes: ['id'], lock: t.LOCK.UPDATE, transaction: t });
  const courant = await Subscription.findOne({
    where: { owner_id: ownerId, status: { [Op.in]: COURANTS } },
    lock: t.LOCK.UPDATE,
    transaction: t,
  });

  if (!courant) {
    const cree = await Subscription.create({
      owner_id: ownerId,
      plan_id: plan.id,
      status: 'actif',
      started_at: new Date(),
      current_period_start: jour,
      current_period_end: ajouterMois(jour, mois),
    }, { transaction: t });
    return { abonnement: cree, avant: null };
  }

  const avant = { status: courant.status, plan_id: courant.plan_id, current_period_end: courant.current_period_end };
  const statut = courant.status === 'suspendu' ? 'suspendu' : 'actif';
  if (courant.plan_id === plan.id && courant.status !== 'essai') {
    const echu = courant.current_period_end < jour;
    await courant.update({
      status: statut,
      current_period_start: echu ? jour : courant.current_period_start,
      current_period_end: ajouterMois(echu ? jour : courant.current_period_end, mois),
    }, { transaction: t });
  } else {
    await courant.update({
      plan_id: plan.id,
      status: statut,
      current_period_start: jour,
      current_period_end: ajouterMois(jour, mois),
    }, { transaction: t });
  }
  return { abonnement: courant, avant };
}

async function notifierActivation(t, ownerId, plan, abonnement) {
  await notifier(t, {
    destinataires: await destinatairesProprietaire(ownerId, t),
    ownerId,
    type: 'abonnement',
    titre: 'Abonnement activé',
    corps: `Votre formule ${plan.name} est active jusqu'au ${formatFr(abonnement.current_period_end)}.`,
    donnees: { subscription_id: abonnement.id },
  });
}

/**
 * IPN PayDunya d'un paiement d'abonnement (§ 31). Appelée par le module webhook.
 *
 * - Authenticité : empreinte de la clé principale de la PLATEFORME, puis
 *   facture RELUE chez PayDunya — statut, montant et référence ne sont jamais
 *   lus dans le corps de l'IPN ; une IPN forgée ou rejouée n'a aucun effet.
 * - Idempotente : ligne verrouillée, une confirmation reçue deux fois n'est
 *   appliquée qu'une fois (§ 56.2 « confirmation reçue deux fois »).
 * - Montant contrôlé : un montant différent de celui demandé ne crédite rien.
 *
 * @returns {Promise<{ ok: boolean, deja?: boolean, motif?: string, statut?: string }>}
 */
async function traiterIpnPaydunya(corps) {
  const identifiants = identifiantsPlateforme();
  if (!identifiants) {
    logger.warn('[abonnement] IPN reçue alors que PayDunya plateforme n’est pas configuré');
    return { ok: false, motif: 'non_configure' };
  }
  let ipn;
  try {
    ipn = await paydunya.verifierIpn(identifiants, corps);
  } catch (err) {
    // PayDunya injoignable : notification non acquittée (503) pour être renvoyée.
    logger.warn('[abonnement] Relecture de la facture PayDunya impossible', { error: err.message });
    throw new ServiceIndisponibleError('Vérification du paiement momentanément impossible', 'FOURNISSEUR_INDISPONIBLE');
  }
  if (!ipn.valide) return { ok: false, motif: ipn.motif };
  if (ipn.evenement === 'ignore') return { ok: true, statut: 'ignore' };
  const charge = ipn.facture;

  let ownerId = null;
  const resultat = await sequelize.transaction(async (t) => {
    const paiement = await SubscriptionPayment.findOne({
      where: ipn.reference
        ? { reference: ipn.reference, provider: 'paydunya' }
        : { provider_transaction_id: ipn.idFournisseur, provider: 'paydunya' },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!paiement) {
      logger.warn('[abonnement] IPN pour une référence inconnue', { reference: ipn.reference });
      return { ok: false, motif: 'reference_inconnue' };
    }
    // La facture relue doit être celle créée pour CE paiement.
    if (paiement.provider_transaction_id && paiement.provider_transaction_id !== ipn.idFournisseur) {
      logger.error('[abonnement] Facture PayDunya étrangère à ce paiement — refusée', { reference: paiement.reference });
      return { ok: false, motif: 'facture_incoherente' };
    }
    // Paiement réellement encaissé après un échec ou une annulation (le
    // propriétaire a finalement payé sur la même demande) : la confirmation,
    // relue chez PayDunya, est appliquée — sinon il aurait payé sans être
    // activé. Seul « confirme » est définitif (idempotence, § 56.2). La reprise
    // est journalisée à part (`reprise_apres`).
    const statutAvant = paiement.status;
    const reprise = ['echoue', 'annule'].includes(statutAvant) && ipn.evenement === 'confirme';
    if (statutAvant !== 'initie' && !reprise) return { ok: true, deja: true, statut: statutAvant };
    if (reprise) {
      logger.warn('[abonnement] Confirmation PayDunya reçue pour un paiement échoué ou annulé — traitement', {
        reference: paiement.reference, statut: statutAvant,
      });
    }
    ownerId = paiement.owner_id;

    if (ipn.evenement === 'annule') {
      await paiement.update({ status: 'annule', raw_payload: charge }, { transaction: t });
      await journaliser({
        action: 'abonnement_paiement.changement_statut', entityType: 'subscription_payment', entityId: paiement.id,
        ownerId, details: { reference: paiement.reference, statut: 'annule' },
      }, t);
      return { ok: true, statut: 'annule' };
    }

    if (ipn.montant !== Number(paiement.amount)) {
      await paiement.update({
        status: 'echoue',
        raw_payload: charge,
        note: `Montant reçu (${ipn.montant}) différent du montant demandé (${paiement.amount}).`,
      }, { transaction: t });
      logger.error('[abonnement] IPN PayDunya : montant incorrect, paiement refusé', {
        reference: paiement.reference, attendu: Number(paiement.amount), recu: ipn.montant,
      });
      await journaliser({
        action: 'abonnement_paiement.changement_statut', entityType: 'subscription_payment', entityId: paiement.id,
        ownerId, details: { reference: paiement.reference, statut: 'echoue', motif: 'montant_incorrect', recu: ipn.montant },
      }, t);
      return { ok: false, motif: 'montant_incorrect' };
    }

    const plan = await SubscriptionPlan.findByPk(paiement.plan_id, { transaction: t });
    const { abonnement, avant } = await appliquerPaiement(ownerId, plan, paiement.months, t);
    await paiement.update({
      status: 'confirme',
      paid_at: new Date(),
      provider_transaction_id: ipn.idFournisseur,
      raw_payload: charge,
      subscription_id: abonnement.id,
    }, { transaction: t });
    await journaliser({
      action: 'abonnement.paiement', entityType: 'subscription', entityId: abonnement.id, ownerId,
      details: {
        reference: paiement.reference, plan: plan.code, mois: paiement.months, montant: Number(paiement.amount),
        avant, fin_periode: abonnement.current_period_end,
        ...(reprise ? { reprise_apres: statutAvant } : {}),
      },
    }, t);
    await notifierActivation(t, ownerId, plan, abonnement);
    return { ok: true, statut: 'confirme', ...(reprise ? { reprise_apres: statutAvant } : {}) };
  });

  if (ownerId) await droits.invalider(ownerId);
  return resultat;
}

/**
 * Activation manuelle par le Super Admin (paiement reçu hors ligne, geste
 * commercial) : même logique d'activation qu'une IPN, tracée par une ligne de
 * paiement `manuel` confirmée et enregistrée par l'administrateur.
 */
async function activerManuellement(adminUser, ownerId, { plan_code: planCode, months, note = null, amount = null }) {
  const owner = await Owner.findByPk(ownerId, { attributes: ['id'] });
  if (!owner) throw new NotFoundError('Propriétaire introuvable');
  const plan = await SubscriptionPlan.findOne({ where: { code: planCode, status: 'actif' } });
  if (!plan) throw new ValidationError('Données invalides', ['Formule inconnue ou indisponible'], 'PLAN_INDISPONIBLE');
  const montant = amount ?? Number(plan.price) * months;

  const resultat = await sequelize.transaction(async (t) => {
    const { abonnement, avant } = await appliquerPaiement(ownerId, plan, months, t);
    const paiement = await SubscriptionPayment.create({
      owner_id: ownerId,
      subscription_id: abonnement.id,
      plan_id: plan.id,
      amount: montant,
      currency: plan.currency,
      months,
      provider: 'manuel',
      reference: await nouvelleReference(t),
      status: 'confirme',
      paid_at: new Date(),
      recorded_by: adminUser.id,
      note,
    }, { transaction: t });
    await journaliser({
      action: 'abonnement.paiement', entityType: 'subscription', entityId: abonnement.id, ownerId,
      details: {
        mode: 'manuel', reference: paiement.reference, plan: plan.code, mois: months, montant, note,
        avant, fin_periode: abonnement.current_period_end,
      },
    }, t);
    await notifierActivation(t, ownerId, plan, abonnement);
    const payment = paiement.toJSON();
    delete payment.raw_payload;
    return { payment, subscription: abonnement };
  });
  await droits.invalider(ownerId);
  return resultat;
}

// ── Expiration (job quotidien) ─────────────────────────────────────────────

/**
 * Passe à « expiré » tout abonnement d'essai ou payé dont la période est
 * échue (§ 31). L'espace passe en lecture seule (droits.service) : le
 * propriétaire consulte toujours ses données, mais doit renouveler pour agir.
 *
 * Une seule requête UPDATE … RETURNING pour toutes les lignes, une seule pour
 * les membres des espaces concernés, un seul INSERT pour le journal d'audit ;
 * puis une notification par propriétaire.
 *
 * @returns {Promise<number>} nombre d'abonnements expirés
 */
async function expirerAbonnements(jour = aujourdhui()) {
  const proprietaires = [];
  const nombre = await sequelize.transaction(async (t) => {
    const [lignes] = await sequelize.query(
      `UPDATE subscriptions SET status = 'expire', updated_at = now()
        WHERE status IN ('essai', 'actif') AND current_period_end < :jour
        RETURNING id, owner_id, current_period_end`,
      { replacements: { jour }, transaction: t }
    );
    if (!lignes.length) return 0;

    const ownerIds = [...new Set(lignes.map((l) => l.owner_id))];
    const membres = await OwnerMember.findAll({
      where: { owner_id: ownerIds, status: 'actif' },
      attributes: ['owner_id', 'user_id'],
      transaction: t,
    });
    const parProprietaire = new Map(ownerIds.map((id) => [id, []]));
    for (const m of membres) parProprietaire.get(m.owner_id).push({ userId: m.user_id });

    // Journal groupé : même contenu que journaliser(), écrit en un INSERT
    // (tâche planifiée, aucun contexte de requête : acteur « systeme »).
    await AuditLog.bulkCreate(lignes.map((l) => ({
      owner_id: l.owner_id,
      actor_role: 'systeme',
      action: 'abonnement.changement_statut',
      entity_type: 'subscription',
      entity_id: l.id,
      details: { statut: 'expire', motif: 'fin_de_periode', fin_periode: l.current_period_end },
    })), { transaction: t });

    for (const l of lignes) {
      await notifier(t, {
        destinataires: parProprietaire.get(l.owner_id),
        ownerId: l.owner_id,
        type: 'abonnement',
        titre: 'Abonnement expiré',
        corps: `Votre abonnement a expiré le ${formatFr(l.current_period_end)}. Votre espace est en lecture seule : renouvelez votre formule pour continuer à gérer vos biens.`,
        donnees: { subscription_id: l.id },
      });
    }
    proprietaires.push(...ownerIds);
    return lignes.length;
  });

  for (const ownerId of proprietaires) await droits.invalider(ownerId);
  if (nombre) logger.info(`[abonnement] ${nombre} abonnement(s) expiré(s)`);
  return nombre;
}

module.exports = {
  plansPublics, planVersApi, etatCourant, historiquePaiements, souscrire,
  traiterIpnPaydunya, activerManuellement, expirerAbonnements,
  identifiantsPlateforme,
};
