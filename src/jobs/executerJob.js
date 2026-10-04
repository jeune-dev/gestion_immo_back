'use strict';

const crypto = require('crypto');
const sequelize = require('../config/db.js');
const { alerter, TYPES } = require('../infrastructure/alertes.service.js');
const logger = require('../utils/logger.js');
const metrics = require('../utils/metrics.js');
const { executerDansContexte } = require('../utils/requestContext.js');

/**
 * Exécution d'une tâche planifiée — reprise du principe de Widjila.
 *
 * - Verrou consultatif PostgreSQL (`pg_try_advisory_lock`) : même avec
 *   plusieurs hôtes ou un redémarrage pendant l'exécution, une tâche ne tourne
 *   JAMAIS deux fois en parallèle (le worker leader PM2 couvre déjà le cas
 *   d'un seul hôte, voir server.js).
 * - Contexte de journalisation (`job`) : chaque ligne écrite pendant la tâche
 *   porte son nom.
 * - Une erreur est journalisée et comptée, jamais propagée : une tâche en
 *   échec ne fait pas tomber le process.
 */

const cleVerrou = (nom) => crypto.createHash('sha256').update(`gestion-imo:${nom}`).digest().readBigInt64BE(0);

async function executerJob(nom, fn) {
  return executerDansContexte({ requestId: `job:${nom}:${Date.now()}`, job: nom }, async () => {
    const connexion = await sequelize.connectionManager.getConnection();
    const cle = cleVerrou(nom).toString();
    const debut = Date.now();
    try {
      const { rows } = await connexion.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [cle]);
      if (!rows[0].ok) {
        metrics.jobIgnore(nom);
        logger.info(`[job] ${nom} déjà en cours ailleurs — passage ignoré`);
        return null;
      }
      metrics.jobDemarre(nom);
      try {
        const resultat = await fn();
        metrics.jobTermine(nom, { succes: true, dureeMs: Date.now() - debut });
        logger.info(`[job] ${nom} terminé en ${Date.now() - debut} ms`, { resultat });
        return resultat;
      } finally {
        await connexion.query('SELECT pg_advisory_unlock($1::bigint)', [cle]);
      }
    } catch (err) {
      metrics.jobTermine(nom, { succes: false, dureeMs: Date.now() - debut, erreur: err });
      logger.error(`[job] ${nom} en échec : ${err.message}`, { stack: err.stack });
      alerter(TYPES.TACHE_EN_ECHEC, `Tâche planifiée « ${nom} » en échec : ${String(err.message).slice(0, 200)}`, { job: nom });
      return null;
    } finally {
      sequelize.connectionManager.releaseConnection(connexion);
    }
  });
}

module.exports = { executerJob, cleVerrou };
