'use strict';

/**
 * Lance src/server.js en CLUSTER de CLUSTER_PROCESSUS processus, comme PM2 en
 * production (ecosystem.config.js, exec_mode « cluster ») — pour
 * scripts/perf/charge.js --processus N. Chaque processus reçoit
 * NODE_APP_INSTANCE (0 = leader : lui seul lancerait les tâches planifiées)
 * et partage le port d'écoute.
 */
const cluster = require('cluster');

// Tourniquet, comme PM2 sous Linux : sous Windows, Node laisse sinon le
// système répartir les connexions, et les connexions keep-alive d'un même
// client s'accumulent sur un seul processus.
cluster.schedulingPolicy = cluster.SCHED_RR;

if (cluster.isPrimary) {
  const n = Math.max(1, Number(process.env.CLUSTER_PROCESSUS || 2));
  for (let i = 0; i < n; i += 1) cluster.fork({ NODE_APP_INSTANCE: String(i) });
  const arreter = () => {
    for (const w of Object.values(cluster.workers)) w.kill();
    process.exit(0);
  };
  process.on('SIGTERM', arreter);
  process.on('SIGINT', arreter);
  // Le parent (charge.js) coupe le canal stdin en se terminant : on suit.
  process.stdin.on('end', arreter).resume();
} else {
  require('../../src/server.js');
}
