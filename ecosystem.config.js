'use strict';

const path = require('path');

/**
 * PM2 (déploiement bare-metal, comme Widjila et Sign).
 * Cluster : un worker par cœur. Seul le worker 0 exécute les tâches planifiées
 * (voir src/server.js). Pool PostgreSQL PAR worker : DB_POOL_MAX × instances
 * doit rester sous max_connections.
 * Avant `pm2 reload` : `npm run migrate && npm run seed && npm run init` (deploy/deploy.sh).
 */
module.exports = {
  apps: [{
    name: 'gestion-imo-api',
    script: path.join(__dirname, 'src', 'server.js'),
    instances: process.env.PM2_INSTANCES || 'max',
    exec_mode: 'cluster',
    env_production: { NODE_ENV: 'production', PORT: 3000, HOST: '127.0.0.1' },
    error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
    out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
    time: true,
    merge_logs: true,
    max_memory_restart: '600M',
    restart_delay: 3000,
    max_restarts: 10,
    min_uptime: '10s',
    watch: false,
    kill_timeout: 12000,
    listen_timeout: 8000,
  }],
};
