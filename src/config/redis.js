'use strict';

const logger = require('../utils/logger.js');

const isProd = process.env.NODE_ENV === 'production';

/**
 * Client Redis partagé (audit — Sécurité §3 / Charge §4).
 *
 * Pourquoi : `express-rate-limit` utilise par défaut un `MemoryStore` propre
 * à CHAQUE process Node. `ecosystem.config.js` lance l'API en cluster PM2
 * (`exec_mode: 'cluster'`, `instances: 'max'` → 4 workers sur le VPS cible).
 * Chaque worker comptait donc les tentatives séparément : une limite
 * annoncée à "5 tentatives de connexion / 15 min" en tolérait en réalité
 * jusqu'à ~20, réparties par le load-balancing round-robin de PM2 entre les
 * workers — sans qu'aucun log ne le signale.
 *
 * Ce module fournit un client Redis UNIQUE, réutilisé par tous les
 * limiteurs (`rateLimit.middleware.js`) et par le cache applicatif
 * (`dashboard.service.js`). Sans `REDIS_URL`, l'app continue de fonctionner
 * (repli sur un store mémoire par middleware, comme avant) — mais un
 * avertissement explicite est journalisé, en particulier en production où
 * le mode cluster rend ce repli silencieusement inefficace.
 */

let client = null;

if (process.env.REDIS_URL) {
  const Redis = require('ioredis');
  client = new Redis(process.env.REDIS_URL, {
    // `rate-limit-redis` et le cache dashboard tolèrent un Redis absent au
    // démarrage (retry en tâche de fond) : on ne bloque jamais le boot de
    // l'API pour un Redis indisponible, on dégrade juste ces deux usages.
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    // CORRECTIF (audit performance / résilience) : Redis tombé, ioredis
    // mettait chaque commande en FILE D'ATTENTE pendant ses reconnexions
    // (10 s par tentative, deux tentatives). Chaque requête HTTP passant par
    // un limiteur de débit attendait donc jusqu'à ~20 s avant d'échouer — et
    // sous charge, des milliers de requêtes s'empilaient ainsi en mémoire.
    // Sans file d'attente, une commande échoue AUSSITÔT quand Redis est
    // injoignable ; les limiteurs laissent alors passer (`passOnStoreError`,
    // rateLimit.middleware.js) et le cache retombe sur un recalcul.
    enableOfflineQueue: false,
    connectTimeout: 2000,
    // Redis CONNECTÉ mais qui ne répond plus (surcharge, commande lente) :
    // sans ce délai, chaque commande attendait indéfiniment. 1 s, puis erreur
    // — que les limiteurs et le cache savent traiter.
    commandTimeout: 1000,
  });

  client.on('error', (err) => {
    logger.warn('[redis] Erreur de connexion (rate limiting et cache dashboard fonctionnent en repli dégradé)', {
      error: err.message,
    });
  });

  client.on('connect', () => {
    logger.info('[redis] Connecté — rate limiting partagé et cache dashboard actifs');
  });
} else if (isProd) {
  // Cluster PM2 + pas de Redis = chaque worker a son propre compteur de
  // rate limiting (voir commentaire ci-dessus). Ce n'est pas fatal, mais ça
  // doit être visible au démarrage plutôt que découvert lors d'un audit.
  logger.warn(
    '[redis] REDIS_URL non défini en production : le rate limiting (login, mutations, admin, OTP) '
    + "est appliqué PAR WORKER PM2, pas globalement — la protection anti brute-force réelle est "
    + 'divisée par le nombre de workers du cluster. Définir REDIS_URL pour un store partagé.'
  );
}

module.exports = client; // null si REDIS_URL absent — les appelants doivent gérer ce cas.
