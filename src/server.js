'use strict';

require('dotenv').config({ quiet: true });
const sequelize = require('./config/db.js');
const app = require('./app.js');
const { demarrerJobs } = require('./jobs/index.js');
const etatApplication = require('./utils/etatApplication.js');
const metrics = require('./utils/metrics.js');
const logger = require('./utils/logger.js');
const { verifierRoleApplicatif } = require('./scripts/rolesBase.js');
const { alerter, TYPES } = require('./infrastructure/alertes.service.js');

/**
 * Démarrage et arrêt propre — repris de Widjila.
 *
 * - Le SCHÉMA n'est jamais modifié ici : les migrations sont appliquées avant
 *   le démarrage (docker-entrypoint.sh en Docker, deploy.sh en PM2).
 * - Tâches planifiées : réservées au worker « leader » (NODE_APP_INSTANCE = 0
 *   en cluster PM2, ou process unique) — sans quoi chaque relance partirait
 *   une fois par worker. Un verrou consultatif PostgreSQL couvre en plus le
 *   cas de plusieurs hôtes (jobs/executerJob.js).
 * - Arrêt : plus de nouvelles requêtes, drainage (10 s max), arrêt des
 *   tâches, fermeture du pool.
 */

const instance = process.env.NODE_APP_INSTANCE;
const estLeader = instance === undefined || instance === '' || instance === '0';

let serveur = null;
let taches = [];
let arretEnCours = false;

/** Alerte (bornée à 3 s) puis arrêt propre : l'incident est signalé avant la sortie. */
function arretSurErreur(motif, message) {
  const alerte = alerter(TYPES.PROCESSUS_ARRETE, `${motif} — arrêt du processus : ${String(message).slice(0, 200)}`, { motif });
  Promise.race([alerte, new Promise((r) => { setTimeout(r, 3000).unref(); })]).finally(() => arretPropre(motif, 1));
}

process.on('uncaughtException', (err) => {
  metrics.incrementer('process.uncaught_exception');
  logger.error(`uncaughtException — arrêt du worker : ${err.message}`, { stack: err.stack });
  arretSurErreur('uncaughtException', err.message);
});
process.on('unhandledRejection', (raison) => {
  const err = raison instanceof Error ? raison : null;
  metrics.incrementer('process.unhandled_rejection');
  logger.error(`unhandledRejection — arrêt du worker : ${err ? err.message : String(raison)}`, { stack: err?.stack });
  arretSurErreur('unhandledRejection', err ? err.message : String(raison));
});

async function demarrer() {
  try {
    await sequelize.authenticate();
    logger.info(`Connexion PostgreSQL établie${estLeader ? '' : ` (worker #${instance})`}`);
    // Jamais de rôle superutilisateur à l'exécution en production (constat M5).
    const { privilegie, role } = await verifierRoleApplicatif(sequelize);
    if (privilegie) logger.warn(`[sécurité] Rôle PostgreSQL privilégié utilisé (« ${role} ») — acceptable en développement uniquement.`);

    if (estLeader && process.env.JOBS_ENABLED !== 'false') {
      taches = demarrerJobs();
    }

    const port = parseInt(process.env.PORT || '3000', 10);
    const hote = process.env.HOST || '0.0.0.0';
    serveur = app.listen(port, hote, () => logger.info(`Serveur lancé sur ${hote}:${port} [${process.env.NODE_ENV || 'development'}]`));
    // Keep-alive plus long que celui de nginx (60 s) : évite les 502 sporadiques.
    Object.assign(serveur, { keepAliveTimeout: 65_000, headersTimeout: 66_000, requestTimeout: 120_000 });
  } catch (err) {
    logger.error('Erreur fatale au démarrage', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

async function arretPropre(signal, codeSortie = 0) {
  if (arretEnCours) return;
  arretEnCours = true;
  etatApplication.signalerArret();
  logger.info(`${signal} reçu — arrêt propre`);
  const filet = setTimeout(() => process.exit(codeSortie), 10_000);
  filet.unref();
  try {
    await Promise.all(taches.map((t) => Promise.resolve(t?.stop?.()).catch(() => {})));
    if (serveur?.listening) {
      const fermeture = new Promise((resolve) => serveur.close(() => resolve()));
      serveur.closeIdleConnections?.();
      await fermeture;
    }
    await sequelize.close();
  } catch (err) {
    logger.error('Erreur pendant l’arrêt propre', { error: err.message });
  } finally {
    clearTimeout(filet);
    process.exit(codeSortie);
  }
}

process.on('SIGTERM', () => arretPropre('SIGTERM'));
process.on('SIGINT', () => arretPropre('SIGINT'));

demarrer();
