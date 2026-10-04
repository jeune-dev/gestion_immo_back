'use strict';

/**
 * Environnement de test : `.env.test` (jamais `.env`), chargé AVANT tout module
 * applicatif. Les variables déjà présentes (CI) sont prioritaires.
 *
 * Chaque worker Jest reçoit SA base (`<DB_NAME>_w<JEST_WORKER_ID>`, clonée par
 * globalSetup.js) : isolation complète en exécution parallèle.
 */
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env.test'), quiet: true });

process.env.NODE_ENV = 'test';
if (!process.env.DB_NAME_MODELE) process.env.DB_NAME_MODELE = process.env.DB_NAME;
if (process.env.JEST_WORKER_ID) process.env.DB_NAME = `${process.env.DB_NAME_MODELE}_w${process.env.JEST_WORKER_ID}`;

process.env.JOBS_ENABLED = 'false';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
// Limiteurs desserrés : les tests enchaînent des dizaines de connexions (les
// limiteurs eux-mêmes sont testés avec des instances dédiées).
for (const [cle, valeur] of Object.entries({
  AUTH_RATE_LIMIT_MAX: '10000', RATE_LIMIT_GLOBAL_MAX: '100000', RATE_LIMIT_UTILISATEUR_MAX: '100000',
  MUTATION_RATE_LIMIT_MAX: '10000', PAIEMENT_RATE_LIMIT_MAX: '10000', OTP_CIBLE_RATE_LIMIT_MAX: '10000',
  SESSION_RATE_LIMIT_MAX: '10000', ADMIN_RATE_LIMIT_MAX: '10000', WEBHOOK_RATE_LIMIT_MAX: '10000',
  UPLOAD_RATE_LIMIT_MAX: '10000', RAPPORT_RATE_LIMIT_MAX: '10000',
})) process.env[cle] = process.env[cle] || valeur;
// bcrypt à coût réduit : les empreintes restent valides, les tests vont vite.
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4';
// Dossier propre à la BASE du worker : deux exécutions Jest simultanées (sur
// des bases différentes) ne comptent jamais les fichiers l'une de l'autre.
process.env.UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(__dirname, '..', '..', '..', 'tmp', `uploads-${process.env.DB_NAME}`);
delete process.env.REDIS_URL;
delete process.env.R2_ACCOUNT_ID;
delete process.env.RESEND_API_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.WHATSAPP_ACCESS_TOKEN;
