'use strict';

require('dotenv').config({ quiet: true });

const isProd = process.env.NODE_ENV === 'production';

// ── Secrets JWT : présents, distincts, et assez longs ──────────────────────────
const SECRETS_JWT = ['JWT_SECRET', 'JWT_REFRESH_SECRET'];
const manquants = SECRETS_JWT.filter((k) => !process.env[k]);
if (manquants.length) {
  throw new Error(`Variables d'environnement manquantes : ${manquants.join(', ')}`);
}
if (process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET) {
  throw new Error('JWT_SECRET et JWT_REFRESH_SECRET doivent être différents.');
}
if (isProd && SECRETS_JWT.some((k) => process.env[k].length < 32)) {
  throw new Error('En production, JWT_SECRET et JWT_REFRESH_SECRET doivent contenir au moins 32 caractères.');
}

// ── CORS : jamais « * » en production ─────────────────────────────────────────
const originesCors = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
if (isProd && originesCors.includes('*')) {
  throw new Error('CORS_ORIGIN=* est interdit en production. Listez les origines explicites (ex : https://admin.exemple.sn).');
}
// Production : origines OBLIGATOIRES et en HTTPS (point faible de l'audit :
// une variable vide retombait sur http://localhost:5173, cookies compris).
if (isProd && !originesCors.length) {
  throw new Error('CORS_ORIGIN est obligatoire en production (ex : https://admin.exemple.sn).');
}
if (isProd && originesCors.some((o) => !o.startsWith('https://'))) {
  throw new Error('En production, chaque origine CORS_ORIGIN doit être en https://.');
}

// ── Politique du mot de passe super-admin (module pur, réexporté) ────────────
const { validerMotDePasseAdmin } = require('./validationMotDePasse.js');

if (isProd && !process.env.APP_ENC_KEY) {
  throw new Error("APP_ENC_KEY est requise en production (chiffrement des données sensibles). Générez-la : node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
}

// ── Secrets de production : bien formés et TOUS distincts (constat M1) ────────
// Contrôlés au DÉMARRAGE : une clé mal formée ne doit pas se révéler au premier
// chiffrement, et un secret réutilisé d'un usage à l'autre (ou copié d'un
// fichier de test) multiplie les dégâts d'une fuite. `npm run secrets:generer`
// produit un jeu complet de secrets neufs.
if (isProd) {
  if (Buffer.from(process.env.APP_ENC_KEY, 'base64').length !== 32) {
    throw new Error('APP_ENC_KEY doit être une chaîne base64 de exactement 32 octets (npm run secrets:generer).');
  }
  if (!process.env.INVITATION_SECRET || process.env.INVITATION_SECRET.length < 32) {
    throw new Error('En production, INVITATION_SECRET est obligatoire et doit contenir au moins 32 caractères (npm run secrets:generer).');
  }
  // Supervision et limites partagées (constat M9) : sans Redis, les limites
  // de débit sont comptées par processus (et contournables en cluster) ; sans
  // jeton, les métriques sont éteintes ; sans canal, aucune alerte ne part.
  if (!process.env.REDIS_URL) {
    throw new Error('En production, REDIS_URL est obligatoire (limites de débit et verrous partagés entre processus).');
  }
  if (!process.env.METRICS_TOKEN || process.env.METRICS_TOKEN.length < 32) {
    throw new Error('En production, METRICS_TOKEN est obligatoire (32 caractères minimum) : supervision des erreurs et des dépendances.');
  }
  if (!process.env.ALERT_WEBHOOK_URL && !process.env.ALERT_EMAIL) {
    throw new Error('En production, configurez au moins un canal d’alerte : ALERT_WEBHOOK_URL et/ou ALERT_EMAIL.');
  }
  // Paiements (constat M11) : pas de bac à sable PayDunya en production, et
  // aucune redirection des appels de paiement vers une autre adresse.
  if (process.env.PAYDUNYA_BASE_URL) {
    throw new Error('PAYDUNYA_BASE_URL est interdite en production (elle redirigerait tous les appels de paiement).');
  }
  if (process.env.PAYDUNYA_MASTER_KEY && process.env.PAYDUNYA_MODE !== 'live' && process.env.PAIEMENT_MODE_TEST_AUTORISE !== '1') {
    throw new Error('En production, PAYDUNYA_MODE doit valoir « live » (clés de production de la plateforme).');
  }
  const vus = new Map();
  for (const cle of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'INVITATION_SECRET', 'APP_ENC_KEY', 'METRICS_TOKEN']) {
    const valeur = process.env[cle];
    if (!valeur) continue;
    if (vus.has(valeur)) throw new Error(`${cle} et ${vus.get(valeur)} doivent être différents (un secret par usage).`);
    vus.set(valeur, cle);
  }
}

/**
 * Jetons (§ 32 : « tokens d'accès courts, refresh token sécurisé, expiration de
 * session »). Le jeton d'accès vit 15 minutes ; le refresh token tourne à chaque
 * usage et expire après 30 jours d'inactivité.
 */
const jwtConfig = {
  secret: process.env.JWT_SECRET,
  expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  refreshSecret: process.env.JWT_REFRESH_SECRET,
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  maxSessionsParUtilisateur: parseInt(process.env.MAX_SESSIONS_PAR_UTILISATEUR || '10', 10),
  algorithme: 'HS256',
};

/**
 * Clé HMAC (KeyObject) d'un secret, préparée UNE fois. Avec une chaîne,
 * `jsonwebtoken` tente à CHAQUE appel `createPublicKey` (qui échoue, donc lève
 * une exception) avant `createSecretKey` : 3 % du temps CPU de l'API sous
 * charge, sur la vérification du jeton de chaque requête (docs/PERFORMANCE.md).
 */
const clesHmac = new Map();
function cleHmac(secret) {
  let cle = clesHmac.get(secret);
  if (!cle) {
    cle = require('crypto').createSecretKey(Buffer.from(secret));
    clesHmac.set(secret, cle);
  }
  return cle;
}

const bcryptConfig = {
  saltRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
};

/** Verrouillage de compte après échecs successifs (anti force brute, § 32). */
const verrouillageConfig = {
  maxTentatives: parseInt(process.env.LOGIN_MAX_TENTATIVES || '5', 10),
  dureeMinutes: parseInt(process.env.LOGIN_BLOCAGE_MINUTES || '15', 10),
};

/**
 * Corps d'une réponse 429 — même enveloppe que le gestionnaire d'erreurs.
 * @param {string} texte
 */
const reponseLimite = (texte) => (req) => ({
  success: false,
  message: texte,
  error: { code: 'TROP_DE_REQUETES', message: texte },
  ...(req?.id ? { requestId: req.id } : {}),
});

const limite = (windowMin, max, texte) => ({
  windowMs: windowMin * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: reponseLimite(texte),
});

const env = (cle, defaut) => parseInt(process.env[cle] || String(defaut), 10);

/** Filet global par IP (anti-scan). */
const rateLimitConfig = limite(15, env('RATE_LIMIT_GLOBAL_MAX', 1000), 'Trop de requêtes. Veuillez réessayer dans quelques minutes.');
/** Par utilisateur authentifié. */
const authenticatedRateLimitConfig = limite(15, env('RATE_LIMIT_UTILISATEUR_MAX', 600), 'Trop de requêtes. Veuillez réessayer dans quelques minutes.');
/** Tentatives d'authentification (connexion, inscription, OTP, activation). */
const authRateLimitConfig = limite(env('AUTH_RATE_LIMIT_WINDOW_MIN', 15), env('AUTH_RATE_LIMIT_MAX', 10), 'Trop de tentatives. Veuillez réessayer dans 15 minutes.');
/** Cycle de session (refresh, logout) — plus large : exige déjà un jeton valide. */
const sessionRateLimitConfig = limite(15, env('SESSION_RATE_LIMIT_MAX', 120), 'Trop de requêtes de session. Veuillez réessayer dans quelques minutes.');
/** Mutations sensibles (mot de passe, sessions). */
const mutationRateLimitConfig = limite(15, env('MUTATION_RATE_LIMIT_MAX', 30), 'Trop de requêtes. Veuillez réessayer dans 15 minutes.');
/** Paiements (initiation, preuve) : bornés par utilisateur. */
const paiementRateLimitConfig = limite(15, env('PAIEMENT_RATE_LIMIT_MAX', 30), 'Trop de demandes de paiement. Réessayez dans quelques minutes.');
/** Webhooks fournisseurs : volume élevé mais borné. */
const webhookRateLimitConfig = limite(1, env('WEBHOOK_RATE_LIMIT_MAX', 300), 'Trop de notifications.');
/** Super admin. */
const adminRateLimitConfig = limite(15, env('ADMIN_RATE_LIMIT_MAX', 600), 'Trop de requêtes admin. Veuillez réessayer.');
/** OTP par identifiant ciblé (anti ciblage multi-IP). */
const otpCibleRateLimitConfig = limite(15, env('OTP_CIBLE_RATE_LIMIT_MAX', 3), 'Trop de demandes pour ce compte. Réessayez dans 15 minutes.');

const corsConfig = {
  origin: originesCors.length ? originesCors : ['http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
  exposedHeaders: ['X-Request-Id', 'Retry-After', 'Content-Disposition'],
  credentials: true,
  maxAge: 600,
};

/** Cookie du refresh token pour le client WEB (super admin). */
const cookieRefresh = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'strict',
  path: '/api/v1/auth',
};

/** Téléversements (§ 19, 20, 22, 37). */
const uploadConfig = {
  maxImageBytes: env('UPLOAD_MAX_IMAGE_MB', 10) * 1024 * 1024,
  maxDocumentBytes: env('UPLOAD_MAX_DOCUMENT_MB', 15) * 1024 * 1024,
  maxVideoBytes: env('UPLOAD_MAX_VIDEO_MB', 60) * 1024 * 1024,
  // Mémoire que les téléversements EN COURS peuvent occuper dans un processus
  // (constat E3) : au-delà, refus immédiat (503) plutôt qu'un dépassement qui
  // ferait redémarrer le processus et tomber toutes ses requêtes.
  memoireMaxOctets: env('UPLOAD_MEMOIRE_MAX_MO', 150) * 1024 * 1024,
  simultanesParUtilisateur: env('UPLOAD_SIMULTANES_PAR_UTILISATEUR', 2),
};

// Téléversements — par utilisateur (fichiers lourds : quota propre, plus serré
// que la limite générale des routes authentifiées).
const televersementRateLimitConfig = limite(15, env('UPLOAD_RATE_LIMIT_MAX', 60), 'Trop de fichiers envoyés. Réessayez dans quelques minutes.');

// Rapports, exports CSV et PDF générés à la volée — par utilisateur (constat
// M12 : requêtes lourdes, jusqu'ici seulement bornées par la limite générale).
const rapportRateLimitConfig = limite(15, env('RAPPORT_RATE_LIMIT_MAX', 60), 'Trop de rapports demandés. Réessayez dans quelques minutes.');

module.exports = {
  isProd,
  jwtConfig,
  cleHmac,
  bcryptConfig,
  verrouillageConfig,
  reponseLimite,
  rateLimitConfig,
  authenticatedRateLimitConfig,
  authRateLimitConfig,
  sessionRateLimitConfig,
  mutationRateLimitConfig,
  paiementRateLimitConfig,
  webhookRateLimitConfig,
  adminRateLimitConfig,
  otpCibleRateLimitConfig,
  televersementRateLimitConfig,
  rapportRateLimitConfig,
  corsConfig,
  cookieRefresh,
  uploadConfig,
  validerMotDePasseAdmin,
};
