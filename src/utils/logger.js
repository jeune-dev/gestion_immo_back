const path = require('path');
const fs = require('fs');
const { createLogger, format, transports } = require('winston');
const { contexteCourant } = require('./requestContext.js');

const { combine, timestamp, printf, colorize, errors } = format;

const isProd = process.env.NODE_ENV === 'production';

// Dossier de logs : LOG_DIR depuis .env, sinon <racine_projet>/logs
const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.resolve(__dirname, '..', '..', 'logs');

if (isProd && !fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const SPLAT = Symbol.for('splat');
const MASQUE = '[masqué]';

/**
 * Arguments TEXTE passés après le message.
 *
 * CORRECTIF : une dizaine d'appels écrivaient `logger.error('…échec :', err.message)`.
 * Winston range ce second argument dans `info[SPLAT]` et, sans format
 * `splat()`, ne l'affiche NULLE PART : la ligne se terminait par « : » et le
 * motif de l'erreur était perdu — jobs nocturnes, envoi de push, création de
 * notification, journal d'audit. Les objets restent fusionnés comme avant
 * (comportement natif de winston) ; seuls les textes et nombres sont
 * recollés au message.
 */
const argumentsTexte = format((info) => {
  const extra = info[SPLAT];
  if (Array.isArray(extra) && extra.length) {
    const textes = extra.filter((v) => v === null || (typeof v !== 'object' && typeof v !== 'function'));
    if (textes.length) info.message = `${info.message} ${textes.join(' ')}`;
  }
  return info;
});

/**
 * Corrélation : identifiant de requête (ou de job) et utilisateur, lus dans le
 * contexte asynchrone posé par `requestId.middleware.js` / `executerJob.js`.
 * Un champ déjà présent dans la ligne n'est jamais écrasé.
 */
const correlation = format((info) => {
  const contexte = contexteCourant();
  if (!contexte) return info;
  if (info.requestId === undefined && contexte.requestId) info.requestId = contexte.requestId;
  if (info.utilisateurId === undefined) {
    const utilisateurId = contexte.utilisateurId;
    if (utilisateurId) info.utilisateurId = utilisateurId;
  }
  if (info.job === undefined && contexte.job) info.job = contexte.job;
  return info;
});

/**
 * Clés dont la VALEUR ne doit jamais atteindre un journal. Comparaison sur le
 * nom normalisé (minuscules, sans `-` ni `_`) : `refresh_token`,
 * `refreshToken` et `Refresh-Token` sont la même clé.
 */
const CLES_SENSIBLES = new Set([
  'password', 'motdepasse', 'nouveaumotdepasse', 'ancienmotdepasse', 'mdp', 'passwd', 'pwd',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'mfatoken', 'resettoken', 'jwt',
  'authorization', 'cookie', 'setcookie',
  'secret', 'clientsecret', 'apisecret', 'apikey', 'xapikey', 'privatekey',
  'otp', 'mfasecret', 'totpsecret', 'hmaccompute', 'credentials', 'iddocumentnumber', 'apisecretsha256', 'apikeysha256', 'webhooksecret',
  'cardnumber', 'numerocarte', 'cvc', 'cvv', 'iban',
]);

const estCleSensible = (cle) => CLES_SENSIBLES.has(String(cle).toLowerCase().replace(/[-_]/g, ''));

/**
 * Masque les valeurs sensibles d'un objet, sur `profondeur` niveaux.
 * Copie À L'ÉCRITURE seulement : l'objet du code appelant n'est jamais modifié,
 * et un objet sans clé sensible est rendu tel quel (aucune copie).
 */
function masquerObjet(valeur, profondeur) {
  if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)
    || valeur instanceof Error || Buffer.isBuffer(valeur) || valeur instanceof Date) {
    return valeur;
  }
  let copie = null;
  for (const cle of Object.keys(valeur)) {
    const avant = valeur[cle];
    let apres = avant;
    if (estCleSensible(cle)) apres = MASQUE;
    else if (profondeur > 0 && avant && typeof avant === 'object') apres = masquerObjet(avant, profondeur - 1);
    if (apres !== avant) {
      if (!copie) copie = { ...valeur };
      copie[cle] = apres;
    }
  }
  return copie || valeur;
}

// `Bearer <jeton>` et tout JWT (trois segments base64url commençant par eyJ).
const MOTIF_SECRET_TEXTE = /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/**
 * Masquage des secrets — dernière barrière avant l'écriture.
 *
 * Volontairement peu coûteux (une ligne est écrite par requête, via morgan) :
 * contrôle des clés de premier niveau et d'un niveau imbriqué (`headers`,
 * `body`…), et une recherche de motif sur le message SEULEMENT s'il contient
 * « Bearer » ou « eyJ ».
 */
const masquage = format((info) => {
  for (const cle of Object.keys(info)) {
    if (cle === 'level' || cle === 'message' || cle === 'stack') continue;
    if (estCleSensible(cle)) info[cle] = MASQUE;
    else if (info[cle] && typeof info[cle] === 'object') info[cle] = masquerObjet(info[cle], 1);
  }
  if (typeof info.message === 'string' && (info.message.includes('Bearer') || info.message.includes('eyJ'))) {
    info.message = info.message.replace(MOTIF_SECRET_TEXTE, (_, prefixe) => (prefixe ? `${prefixe}${MASQUE}` : MASQUE));
  }
  return info;
});

// Champs déjà rendus par le gabarit de développement — tout le reste est
// affiché après le message. L'ancien gabarit n'affichait QUE le message : en
// local, `logger.error('Échec', { error: err.message })` n'en montrait rien.
const CHAMPS_GABARIT = new Set(['level', 'message', 'timestamp', 'stack', 'requestId']);

const devFormat = combine(
  errors({ stack: true }),
  argumentsTexte(),
  correlation(),
  masquage(),
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  printf((info) => {
    const reste = {};
    for (const cle of Object.keys(info)) if (!CHAMPS_GABARIT.has(cle)) reste[cle] = info[cle];
    const meta = Object.keys(reste).length ? ` ${JSON.stringify(reste)}` : '';
    const id = info.requestId ? `[${String(info.requestId).slice(0, 8)}] ` : '';
    const ligne = `${info.timestamp} ${info.level}: ${id}${info.message}${meta}`;
    return info.stack ? `${ligne}\n${info.stack}` : ligne;
  })
);

const prodFormat = combine(
  errors({ stack: true }),
  argumentsTexte(),
  correlation(),
  masquage(),
  timestamp(),
  format.json()
);

const loggerTransports = [new transports.Console()];

// Un fichier PAR PROCESSUS (point faible de l'audit) : plusieurs workers PM2
// qui écrivent et font tourner le MÊME fichier perdent ou entremêlent des lignes.
const SUFFIXE_INSTANCE = process.env.NODE_APP_INSTANCE ? `-${process.env.NODE_APP_INSTANCE}` : '';

if (isProd) {
  // Rotation par taille assurée par winston lui-même (maxsize / maxFiles).
  // Les journaux PM2 (stdout du process, pm2-*.log) ont besoin de
  // pm2-logrotate — installé par deploy/setup-server.sh. Conservation longue :
  // centraliser hors du serveur (voir docs/EXPLOITATION.md).
  loggerTransports.push(
    new transports.File({
      filename: path.join(LOG_DIR, `error${SUFFIXE_INSTANCE}.log`),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
    new transports.File({
      filename: path.join(LOG_DIR, `app${SUFFIXE_INSTANCE}.log`),
      maxsize: 20 * 1024 * 1024, // 20 MB
      maxFiles: 10,
      tailable: true,
    })
  );
}

const logger = createLogger({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  format: isProd ? prodFormat : devFormat,
  // En cluster PM2, plusieurs workers écrivent dans les mêmes fichiers : sans
  // l'instance, une ligne d'erreur ne dit pas quel process l'a produite.
  defaultMeta: isProd ? { service: 'gestion-imo-api', instance: process.env.NODE_APP_INSTANCE ?? '0' } : undefined,
  transports: loggerTransports,
});

module.exports = logger;
module.exports.estCleSensible = estCleSensible;
module.exports.masquerObjet = masquerObjet;
