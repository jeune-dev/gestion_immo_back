'use strict';

/**
 * Environnement de test : `.env.test` (jamais `.env`), chargé AVANT tout module
 * applicatif. Les variables déjà présentes (CI) sont prioritaires.
 *
 * Chaque worker Jest reçoit SA base (`<DB_NAME>_w<JEST_WORKER_ID>`, clonée par
 * globalSetup.js) : isolation complète en exécution parallèle.
 */
const path = require('path');
const http = require('http');

// Node ≥ 19 garde les connexions ouvertes (keep-alive) ; supertest démarre un
// serveur éphémère par requête : une connexion réutilisée vers un serveur déjà
// fermé (port recyclé) donnait au hasard « socket hang up » ou une réponse
// étrangère (405 sans corps). Une connexion neuve par requête en test.
http.globalAgent = new http.Agent({ keepAlive: false });

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
  MUTATION_RATE_LIMIT_MAX: '10000', PAIEMENT_RATE_LIMIT_MAX: '10000', OTP_CIBLE_RATE_LIMIT_MAX: '10000', MOT_DE_PASSE_OUBLIE_RATE_LIMIT_MAX: '10000',
  SESSION_RATE_LIMIT_MAX: '10000', ADMIN_RATE_LIMIT_MAX: '10000', WEBHOOK_RATE_LIMIT_MAX: '10000',
  UPLOAD_RATE_LIMIT_MAX: '10000', RAPPORT_RATE_LIMIT_MAX: '10000',
})) process.env[cle] = process.env[cle] || valeur;
// bcrypt à coût réduit : les empreintes restent valides, les tests vont vite.
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4';
// Dossier propre à la BASE du worker : deux exécutions Jest simultanées (sur
// des bases différentes) ne comptent jamais les fichiers l'une de l'autre.
// globalSetup charge aussi ce fichier, dans le processus PARENT (base modèle) :
// sa valeur, héritée par les workers, désignerait un dossier COMMUN — on la
// recalcule pour la base du worker. Une valeur fournie explicitement est gardée.
const dossierUploads = (base) => path.resolve(__dirname, '..', '..', '..', 'tmp', `uploads-${base}`);
if (!process.env.UPLOAD_DIR || process.env.UPLOAD_DIR === dossierUploads(process.env.DB_NAME_MODELE)) {
  process.env.UPLOAD_DIR = dossierUploads(process.env.DB_NAME);
}
delete process.env.REDIS_URL;
delete process.env.R2_ACCOUNT_ID;
delete process.env.RESEND_API_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
delete process.env.WHATSAPP_ACCESS_TOKEN;
