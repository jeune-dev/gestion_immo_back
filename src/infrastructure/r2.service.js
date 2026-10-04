'use strict';

/**
 * r2.service.js — Stockage Cloudflare R2 (compatible S3), repris de Widjila.
 *
 * Variables d'environnement :
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *
 * Le bucket est PRIVÉ : photos de travaux, pièces d'identité, justificatifs,
 * contrats et quittances ne sont jamais publics. L'accès passe par l'API, qui
 * contrôle les droits, ou par une URL signée de quelques minutes.
 *
 * Le client est initialisé PARESSEUSEMENT : l'application démarre sans
 * configuration R2, et `storage.service.js` retombe alors sur le disque local.
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const logger = require('../utils/logger.js');

const BUCKET = process.env.R2_BUCKET_NAME;

let client = null;
let clientInitialise = false;

/** Vrai si toutes les variables R2 nécessaires sont présentes. */
function estConfigure() {
  return Boolean(
    process.env.R2_ACCOUNT_ID
    && process.env.R2_ACCESS_KEY_ID
    && process.env.R2_SECRET_ACCESS_KEY
    && BUCKET
  );
}

function getClient() {
  if (clientInitialise) return client;
  clientInitialise = true;

  if (!estConfigure()) {
    logger.warn('[r2] Configuration incomplète — stockage local utilisé (variables R2_* absentes)');
    return null;
  }

  client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    // DÉLAIS. Le client n'en avait aucun : une connexion R2 qui ne s'établit
    // pas, ou une réponse qui ne vient pas, retenait indéfiniment la requête
    // de l'utilisateur (plan, photo, rapport). Attention : sans
    // `throwOnRequestTimeout`, le SDK se contente d'un AVERTISSEMENT en
    // console quand `requestTimeout` est dépassé — la requête continue.
    // Le délai de requête court jusqu'aux EN-TÊTES de la réponse, pas jusqu'à
    // la fin du flux : un gros fichier relayé vers le client n'est pas coupé.
    requestHandler: {
      connectionTimeout: parseInt(process.env.R2_CONNECT_TIMEOUT_MS || '5000', 10),
      requestTimeout: parseInt(process.env.R2_REQUEST_TIMEOUT_MS || '120000', 10),
      throwOnRequestTimeout: true,
    },
    // Reprises du SDK (délai exponentiel avec part aléatoire), limitées aux
    // erreurs réseau et 5xx/429 — les 4xx ne sont jamais rejouées.
    maxAttempts: 3,
  });
  return client;
}

/** Client R2 garanti non nul, sinon erreur explicite. */
function requireClient() {
  const c = getClient();
  if (!c) throw new Error('Stockage R2 non configuré (variables R2_* manquantes).');
  return c;
}

/**
 * Sonde de disponibilité (audit — Charge à 10 000 utilisateurs §4).
 *
 * Utilisée par `GET /health`, qui ne vérifiait auparavant QUE la base de
 * données : derrière un load-balancer multi-instances, une panne R2 (le
 * stockage de toutes les photos et de tous les documents) passait inaperçue de la
 * supervision alors que l'application était en réalité dégradée.
 *
 * `HeadBucketCommand` est l'appel S3 le plus léger qui vérifie à la fois les
 * identifiants ET la joignabilité réseau, sans transférer de données.
 */
async function ping() {
  if (!estConfigure()) return { configure: false, joignable: null };
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: BUCKET }));
    return { configure: true, joignable: true };
  } catch (err) {
    logger.warn('[r2] Sonde de disponibilité en échec', { error: err.message });
    return { configure: true, joignable: false, erreur: err.message };
  }
}

// ── Types MIME ────────────────────────────────────────────────────────────────

/**
 * Content-Type déduit de l'extension. Il est posé à l'upload pour que R2 le
 * renvoie ensuite : sans lui, tout ressortirait en application/octet-stream.
 */
const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  // Documents bureautiques
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  // `application/acad` plutôt que `image/vnd.dwg` : un type en `image/` ferait
  // ranger le plan parmi les PHOTOS par les clients qui trient sur ce préfixe.
  '.dwg': 'application/acad',
};

function contentType(nomFichier) {
  return TYPES[path.extname(nomFichier || '').toLowerCase()] || 'application/octet-stream';
}

// ── Utilitaires ───────────────────────────────────────────────────────────────

/** Convertit le flux renvoyé par R2 en Buffer. */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    stream.on('data', (c) => morceaux.push(c));
    stream.on('end', () => resolve(Buffer.concat(morceaux)));
    stream.on('error', reject);
  });
}

/**
 * Normalise une valeur stockée en base vers une clé R2.
 * Trois formes acceptées, pour supporter la migration sans toucher aux données :
 *   - clé nue          « owners/x/travaux/1734-ab.jpg »        → telle quelle
 *   - chemin backend   « /uploads/owners/x/travaux/1734-ab.jpg » → préfixe retiré
 *   - URL publique     « https://pub-x.r2.dev/…/x » → origine retirée
 */
function versCle(valeur) {
  if (!valeur) return null;
  let cle = String(valeur);

  if (cle.startsWith('http')) {
    try {
      cle = new URL(cle).pathname;
    } catch {
      return null;
    }
  }
  cle = cle.replace(/^\/+/, '');
  if (cle.startsWith('uploads/')) cle = cle.slice('uploads/'.length);

  // Anti-traversée : une clé R2 ne remonte jamais d'arborescence.
  if (!cle || cle.includes('..')) return null;
  return cle;
}

// ── Écriture ──────────────────────────────────────────────────────────────────

/**
 * Envoie un buffer sur R2.
 * @param {Buffer} buffer
 * @param {string} cle — clé complète dans le bucket (ex. « owners/x/travaux/1734-ab.jpg »)
 * @param {string} [nomOrigine] — sert uniquement à déduire le Content-Type
 * @returns {Promise<string>} la clé écrite
 */
async function upload(buffer, cle, nomOrigine = cle) {
  await requireClient().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: cle,
    Body: buffer,
    ContentType: contentType(nomOrigine),
  }));
  return cle;
}

// ── Lecture ───────────────────────────────────────────────────────────────────

/** Télécharge un objet et renvoie `{ buffer, contentType, taille }`. */
async function download(valeur) {
  const cle = versCle(valeur);
  if (!cle) throw new Error('Clé R2 invalide');

  const reponse = await requireClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: cle }));
  return {
    buffer: await streamToBuffer(reponse.Body),
    contentType: reponse.ContentType || contentType(cle),
    taille: reponse.ContentLength,
  };
}

/** Flux brut — évite de charger tout le fichier en mémoire (vidéos, gros PDF). */
async function getStream(valeur) {
  const cle = versCle(valeur);
  if (!cle) throw new Error('Clé R2 invalide');

  const reponse = await requireClient().send(new GetObjectCommand({ Bucket: BUCKET, Key: cle }));
  return {
    stream: reponse.Body,
    contentType: reponse.ContentType || contentType(cle),
    taille: reponse.ContentLength,
  };
}

/** Vrai si l'objet existe dans le bucket. */
async function existe(valeur) {
  const cle = versCle(valeur);
  if (!cle || !getClient()) return false;
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: cle }));
    return true;
  } catch {
    return false;
  }
}

/**
 * URL signée temporaire — exigence du cahier des charges : « les liens de
 * téléchargement doivent être temporaires et signés ».
 * @param {string} valeur — clé ou chemin stocké en base
 * @param {number} [expiresIn] — durée de validité en secondes (défaut 1 h)
 */
async function urlSignee(valeur, expiresIn = 3600) {
  const cle = versCle(valeur);
  if (!cle) throw new Error('Clé R2 invalide');
  return getSignedUrl(
    requireClient(),
    new GetObjectCommand({ Bucket: BUCKET, Key: cle }),
    { expiresIn }
  );
}

// ── Suppression ───────────────────────────────────────────────────────────────

/** Supprime un objet. Best-effort : ne doit jamais faire échouer l'action métier. */
async function supprimer(valeur) {
  const cle = versCle(valeur);
  if (!cle) return false;
  try {
    await requireClient().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: cle }));
    logger.info(`[r2] Objet supprimé : ${cle}`);
    return true;
  } catch (err) {
    logger.warn(`[r2] Suppression impossible (${cle}) : ${err.message}`);
    return false;
  }
}

module.exports = {
  estConfigure,
  upload,
  download,
  getStream,
  existe,
  urlSignee,
  supprimer,
  versCle,
  contentType,
  ping,
};
