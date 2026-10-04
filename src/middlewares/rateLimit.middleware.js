'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redisClient = require('../config/redis.js');
const logger = require('../utils/logger.js');
const metrics = require('../utils/metrics.js');
const { normaliserTelephone } = require('../utils/telephone.js');
const { signalerDepassementLimite } = require('../infrastructure/alertes.service.js');
const {
  authRateLimitConfig,
  sessionRateLimitConfig,
  mutationRateLimitConfig,
  adminRateLimitConfig,
  otpCibleRateLimitConfig,
  authenticatedRateLimitConfig,
  paiementRateLimitConfig,
  webhookRateLimitConfig,
  televersementRateLimitConfig,
  rapportRateLimitConfig,
} = require('../config/security.js');

/**
 * Store Redis qui se RÉTABLIT après une indisponibilité au démarrage.
 *
 * CORRECTIF (panne en cascade Redis → authentification). `RedisStore` charge
 * ses scripts Lua une seule fois, dans `init()`, et garde la PROMESSE de leur
 * empreinte. Si Redis était injoignable à cet instant (redémarrage du
 * serveur Redis, démarrage de l'API avant lui dans docker compose), cette
 * promesse restait REJETÉE pour toujours : chaque `increment` la réattendait,
 * rejetait à nouveau, et la bibliothèque ne recharge le script que sur une
 * erreur `NOSCRIPT` — jamais sur celle-ci. Résultat : login, refresh,
 * logout, mot de passe oublié répondaient 500 jusqu'au redémarrage de l'API,
 * même longtemps après le retour de Redis. Reproduit par
 * `rateLimit.redisIndisponible.test.js`.
 *
 * Ici, après un échec, les scripts sont rechargés si leur chargement avait
 * échoué (au plus une tentative toutes les 2 s, pour ne pas marteler un
 * Redis en panne).
 */
class StoreRedisResilient extends RedisStore {
  async init(options) {
    this.windowMs = options.windowMs;
    this._chargerScripts();
    await Promise.all([this.incrementScriptSha, this.getScriptSha]);
  }

  async increment(cle) {
    try {
      return await super.increment(cle);
    } catch (err) {
      await this._apresEchec();
      throw err;
    }
  }

  async get(cle) {
    try {
      return await super.get(cle);
    } catch (err) {
      await this._apresEchec();
      throw err;
    }
  }

  _chargerScripts() {
    this._derniereTentative = Date.now();
    this.incrementScriptSha = this.loadIncrementScript();
    this.getScriptSha = this.loadGetScript();
    // Écouteurs posés sur les DEUX promesses : un rejet non écouté remonterait
    // en `unhandledRejection`, qui arrête le process.
    this._scriptsPrets = Promise.all([this.incrementScriptSha, this.getScriptSha]).then(() => true, () => false);
  }

  async _apresEchec() {
    if (await this._scriptsPrets) return; // scripts chargés : la panne est ailleurs (Redis coupé), rien à recharger
    if (Date.now() - this._derniereTentative < 2000) return;
    this._chargerScripts();
  }

  /** Appelé quand la connexion Redis (re)devient prête : recharge si le chargement avait échoué. */
  async rechargerSiNecessaire() {
    if (!(await this._scriptsPrets)) this._chargerScripts();
  }
}

/** Stores créés — rechargés dès que Redis redevient disponible. */
const storesRedis = new Set();

// Le client Redis n'accepte aucune commande avant d'être connecté
// (`enableOfflineQueue: false`, config/redis.js) : au démarrage, le
// chargement des scripts échoue donc presque toujours. On le relance dès que
// la connexion est prête, sans attendre qu'une requête échoue.
if (redisClient && typeof redisClient.on === 'function') {
  redisClient.on('ready', () => {
    for (const store of storesRedis) {
      store.rechargerSiNecessaire().catch((err) => {
        logger.warn('[rate-limit] Rechargement des scripts impossible', { error: err.message });
      });
    }
  });
}

/**
 * Journal des erreurs de store : une panne Redis ne doit ni bloquer les
 * requêtes, ni passer inaperçue.
 */
const journalStore = {
  error: (err, message) => {
    metrics.incrementer('rate_limit.erreur_store');
    logger.warn(`[rate-limit] ${message || 'erreur du store'}`, { error: err?.message || String(err) });
  },
  warn: (message) => logger.warn(`[rate-limit] ${message}`),
};

/**
 * Store partagé (audit — Sécurité §3) : si REDIS_URL est configuré, TOUS les
 * limiteurs comptent dans le même Redis, quel que soit le worker PM2 qui
 * traite la requête — le mode cluster ne dilue plus la protection.
 *
 * Sans Redis, chaque limiteur retombe sur le `MemoryStore` par défaut
 * d'express-rate-limit (comportement historique, par process) : l'app reste
 * fonctionnelle en développement / déploiement mono-instance, seul le
 * comportement en cluster est différent (voir avertissement dans
 * config/redis.js).
 */
const sharedStore = (prefix) => {
  if (!redisClient) return undefined;
  const store = new StoreRedisResilient({
    prefix: `rl:${prefix}:`,
    // `call` (et non `sendCommand`) : signature attendue par rate-limit-redis
    // v6 pour un client ioredis.
    sendCommand: (...args) => redisClient.call(...args),
  });
  storesRedis.add(store);
  return store;
};

/**
 * Options communes aux limiteurs adossés à Redis.
 *
 * `passOnStoreError` : si Redis ne répond pas, la requête PASSE sans être
 * comptée (et l'incident est journalisé + compté). L'alternative — le
 * comportement par défaut — répondait 500 : une panne du cache devenait une
 * panne de l'authentification pour tous les utilisateurs. Le limiteur global
 * (mémoire, app.js) et le verrouillage de compte après échecs répétés
 * (auth.service.js, en base) restent actifs pendant la panne.
 */
/**
 * Dépassement d'une limite : journalisé (IP, utilisateur, limiteur), compté
 * dans les métriques, et alerte si les refus se multiplient (constat M9 —
 * les 429 ne laissaient aucune trace : un bourrage d'identifiants restait
 * invisible). Réponse identique au gestionnaire par défaut.
 */
const journaliserDepassement = (limiteur) => async (req, res, next, options) => {
  metrics.incrementer(`rate_limit.depasse.${limiteur}`);
  logger.warn('[limite] Limite de débit dépassée', { limiteur, ip: req.ip, utilisateurId: req.user?.id, chemin: req.originalUrl?.split('?')[0] });
  signalerDepassementLimite({ limiteur });
  res.status(options.statusCode);
  res.send(typeof options.message === 'function' ? await options.message(req, res) : options.message);
};

const optionsStore = (prefixe) => {
  const store = sharedStore(prefixe);
  return {
    handler: journaliserDepassement(prefixe),
    ...(store ? { store, passOnStoreError: true, logger: journalStore } : {}),
  };
};

// Tentatives d'AUTHENTIFICATION (connexion, inscription, activation, OTP) —
// par IP. Ce sont les seules routes où un attaquant devine un secret en
// réessayant ; le verrouillage de compte (auth.service) complète la protection
// indépendamment de l'IP.
const authRateLimit = rateLimit({ ...authRateLimitConfig, ...optionsStore('auth') });

// Cycle de SESSION (refresh, logout) — compteur séparé : un rafraîchissement
// automatique ne consomme pas le budget des tentatives de connexion.
const sessionRateLimit = rateLimit({ ...sessionRateLimitConfig, ...optionsStore('session') });

/** Clé = utilisateur authentifié, repli sur l'IP. À placer APRÈS `auth`. */
const parUtilisateur = (req, res) => req.user?.id || ipKeyGenerator(req, res);

// Mutations sensibles (mot de passe, sessions) — par utilisateur.
const mutationRateLimit = rateLimit({ ...mutationRateLimitConfig, ...optionsStore('mutation'), keyGenerator: parUtilisateur });

// Super admin — par utilisateur.
const adminRateLimit = rateLimit({ ...adminRateLimitConfig, ...optionsStore('admin'), keyGenerator: parUtilisateur });

// Initiation de paiement et dépôt de preuve — par utilisateur (§ 44 double clic,
// l'idempotence protège déjà contre le doublon ; ceci borne l'abus).
const paiementRateLimit = rateLimit({ ...paiementRateLimitConfig, ...optionsStore('paiement'), keyGenerator: parUtilisateur });

// Téléversements (photos, vidéos, justificatifs) — par utilisateur.
const televersementRateLimit = rateLimit({ ...televersementRateLimitConfig, ...optionsStore('televersement'), keyGenerator: parUtilisateur });

// Rapports, exports et PDF générés à la volée — par utilisateur (constat M12).
const rapportRateLimit = rateLimit({ ...rapportRateLimitConfig, ...optionsStore('rapport'), keyGenerator: parUtilisateur });

// Webhooks fournisseurs (PayDunya, Wave, WhatsApp) — par IP.
const webhookRateLimit = rateLimit({ ...webhookRateLimitConfig, ...optionsStore('webhook') });

/**
 * Clé du compte VISÉ, normalisée exactement comme la recherche du compte
 * (auth.service `critereIdentifiant`) : sans cela, « 771234567 »,
 * « +221 77 123 45 67 » ou « 77-123-45-67 » — un seul compte — obtenaient
 * chacun leur propre quota (constat E2 de l'audit).
 */
function cleCibleOtp(req) {
  const brut = String(req.body?.identifiant || req.body?.email || req.body?.telephone || '').trim();
  if (!brut) return null;
  if (brut.includes('@')) return `email:${brut.toLowerCase()}`;
  const tel = normaliserTelephone(brut);
  return tel ? `tel:${tel}` : `brut:${brut.toLowerCase()}`;
}

// OTP / activation par IDENTIFIANT ciblé (anti ciblage multi-IP).
const otpCibleRateLimit = rateLimit({
  ...otpCibleRateLimitConfig,
  ...optionsStore('otp'),
  keyGenerator: (req, res) => cleCibleOtp(req) || ipKeyGenerator(req, res),
  skip: (req) => !(req.body?.identifiant || req.body?.email || req.body?.telephone),
});

// Routes authentifiées — par UTILISATEUR (plusieurs comptes derrière la même
// IP 4G ne se bloquent pas mutuellement).
const authenticatedRateLimit = rateLimit({
  ...authenticatedRateLimitConfig,
  ...optionsStore('authenticated'),
  keyGenerator: parUtilisateur,
});

module.exports = {
  authRateLimit, sessionRateLimit, mutationRateLimit, adminRateLimit,
  paiementRateLimit, webhookRateLimit, otpCibleRateLimit, authenticatedRateLimit,
  televersementRateLimit, rapportRateLimit, StoreRedisResilient, journalStore, cleCibleOtp, journaliserDepassement,
};
