'use strict';

// firebase-admin v12+ expose une API MODULAIRE : l'export racine
// (`require('firebase-admin')`) ne porte plus `admin.credential.cert(...)` ni
// `admin.messaging(app)` (l'ancienne API namespacée, encore documentée dans
// beaucoup de tutoriels). Il faut passer par les sous-chemins dédiés — sans
// quoi `admin.credential` vaut `undefined` et l'appel échoue silencieusement
// avec « Cannot read properties of undefined (reading 'cert') ».
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging: getMessagingPourApp } = require('firebase-admin/messaging');
const logger = require('../utils/logger.js');

/**
 * Firebase Admin — initialisation PARESSEUSE et TOLÉRANTE.
 *
 * Même parti pris que le client Resend (voir `infrastructure/emailService.js`) :
 * sans compte de service configuré, l'application démarre quand même et les
 * envois de push sont simplement ignorés. C'est ce qui permet de développer en
 * local, de faire tourner les tests et de déployer un environnement sans
 * Firebase sans que rien ne casse — le push est un canal SECONDAIRE, la
 * notification in-app reste enregistrée en base dans tous les cas.
 *
 * Configuration : `FIREBASE_SERVICE_ACCOUNT_JSON` contient le contenu du
 * fichier JSON de compte de service, soit tel quel, soit encodé en base64
 * (pratique pour les variables d'environnement d'hébergeurs qui supportent mal
 * les sauts de ligne et les guillemets).
 */

let app = null;
let initialise = false;

/** Lit la variable d'environnement, en acceptant du JSON brut ou du base64. */
function _lireCompteDeService() {
  const brut = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!brut || !brut.trim()) return null;

  const valeur = brut.trim();
  const texte = valeur.startsWith('{')
    ? valeur
    : Buffer.from(valeur, 'base64').toString('utf8');

  try {
    return JSON.parse(texte);
  } catch (err) {
    // Journaliser l'erreur d'analyse, jamais le contenu : cette variable porte
    // une clé privée.
    logger.error('[push] FIREBASE_SERVICE_ACCOUNT_JSON illisible (JSON invalide) — push désactivé');
    return null;
  }
}

/**
 * Retourne l'application Firebase Admin, ou `null` si elle n'est pas
 * configurée. L'appelant DOIT gérer le cas `null`.
 */
function getFirebaseApp() {
  if (initialise) return app;
  initialise = true;

  const compte = _lireCompteDeService();
  if (!compte) {
    logger.warn('[push] FIREBASE_SERVICE_ACCOUNT_JSON non définie — notifications push désactivées');
    return null;
  }

  try {
    app = initializeApp({ credential: cert(compte) });
    logger.info(`[push] Firebase Admin initialisé (projet ${compte.project_id})`);
  } catch (err) {
    logger.error('[push] Initialisation Firebase impossible — push désactivé', { error: err.message });
    app = null;
  }
  return app;
}

/** Messagerie FCM, ou `null` si Firebase n'est pas configuré. */
function getMessaging() {
  const application = getFirebaseApp();
  return application ? getMessagingPourApp(application) : null;
}

module.exports = { getFirebaseApp, getMessaging };
