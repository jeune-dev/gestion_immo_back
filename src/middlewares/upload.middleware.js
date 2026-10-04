'use strict';

const multer = require('multer');
const { uploadConfig } = require('../config/security.js');
const { AppError, BadRequestError, ServiceIndisponibleError } = require('../errors/AppError.js');
const { televersementRateLimit } = require('./rateLimit.middleware.js');

/**
 * Téléversements (photos de travaux, justificatifs, preuves de paiement,
 * pièces d'identité, vidéos d'incident, documents) — repris de Widjila.
 *
 * - Stockage en MÉMOIRE (jamais de fichier temporaire sur disque) : le fichier
 *   part ensuite vers le stockage objet via storage.service.
 * - Le TYPE RÉEL est déterminé par la signature binaire (magic bytes), jamais
 *   par le Content-Type ou l'extension fournis par le client : un exécutable
 *   renommé en .jpg est refusé, et l'extension stockée dérive du contenu —
 *   ce qui ferme le XSS stocké par fichier HTML déguisé.
 * - Plafond de taille PAR NATURE de fichier (image, document, vidéo).
 */

/** @returns {'jpg'|'png'|'webp'|'pdf'|'mp4'|'mov'|'webm'|null} */
function detecterType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const marque = buffer.toString('ascii', 8, 12);
    if (marque.startsWith('qt')) return 'mov';
    if (/^(isom|iso2|mp41|mp42|avc1|M4V |3gp)/.test(marque)) return 'mp4';
    return null;
  }
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return 'webm';
  return null;
}

const MIME = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};
const IMAGES = new Set(['jpg', 'png', 'webp']);
const VIDEOS = new Set(['mp4', 'mov', 'webm']);

/** Familles de fichiers admises par route. */
const FAMILLES = Object.freeze({
  image: { types: IMAGES, libelle: 'une image JPEG, PNG ou WebP' },
  justificatif: { types: new Set([...IMAGES, 'pdf']), libelle: 'une image (JPEG, PNG, WebP) ou un PDF' },
  media: { types: new Set([...IMAGES, ...VIDEOS]), libelle: 'une photo ou une vidéo (MP4, MOV, WebM)' },
  document: { types: new Set([...IMAGES, 'pdf']), libelle: 'un PDF ou une image' },
});

const plafond = (type) => {
  if (VIDEOS.has(type)) return uploadConfig.maxVideoBytes;
  if (type === 'pdf') return uploadConfig.maxDocumentBytes;
  return uploadConfig.maxImageBytes;
};

const enMo = (octets) => Math.round(octets / (1024 * 1024));

// ── Mémoire bornée (constat E3 de l'audit de sécurité) ─────────────────────
// Le fichier est lu en mémoire (type réel, retrait EXIF, empreinte
// d'idempotence en ont besoin). Sans borne, une dizaine de vidéos de 60 Mo
// envoyées en même temps dépassaient la mémoire du processus : redémarrage,
// et toutes ses requêtes en cours perdues (déni de service).
//   - budget PAR PROCESSUS réservé AVANT de lire le corps, d'après sa taille
//     annoncée (Content-Length) ; épuisé → 503 immédiat avec Retry-After (pas
//     de file d'attente, qui ferait elle-même grossir la mémoire) ;
//   - au plus N téléversements simultanés PAR UTILISATEUR → 429 ;
//   - un corps plus gros que le plafond de la route ne coûte que ce plafond :
//     multer cesse de stocker à la limite et lit le reste pour le jeter.
// Un envoi refusé est LU ET JETÉ (jamais stocké) avant la réponse : couper la
// connexion pendant que le client envoie encore lui donnerait une erreur
// réseau (ECONNRESET) au lieu d'un message clair.

const MARGE_MULTIPART = 256 * 1024; // en-têtes multipart + champs texte
const etatMemoire = { reserve: 0, parUtilisateur: new Map() };

function reserverMemoire(req, res, transportMax) {
  const annonce = Number(req.headers['content-length']);
  const aReserver = Number.isFinite(annonce) && annonce > 0 ? Math.min(annonce, transportMax + MARGE_MULTIPART) : transportMax + MARGE_MULTIPART;
  const utilisateur = req.user?.id || req.ip;
  const siens = etatMemoire.parUtilisateur.get(utilisateur) || 0;
  if (siens >= uploadConfig.simultanesParUtilisateur) {
    return new AppError('Un envoi de fichier est déjà en cours. Attendez sa fin avant d’en lancer un autre.', 429, true, 'TELEVERSEMENTS_SIMULTANES');
  }
  if (etatMemoire.reserve + aReserver > uploadConfig.memoireMaxOctets) {
    return new ServiceIndisponibleError("Le serveur reçoit déjà beaucoup de fichiers. Réessayez dans quelques secondes.", 'TELEVERSEMENTS_SATURES', { reessayerDansS: 5 });
  }
  etatMemoire.reserve += aReserver;
  etatMemoire.parUtilisateur.set(utilisateur, siens + 1);
  let libere = false;
  const liberer = () => {
    if (libere) return;
    libere = true;
    etatMemoire.reserve -= aReserver;
    const restant = (etatMemoire.parUtilisateur.get(utilisateur) || 1) - 1;
    if (restant > 0) etatMemoire.parUtilisateur.set(utilisateur, restant);
    else etatMemoire.parUtilisateur.delete(utilisateur);
  };
  // `close` couvre aussi la coupure réseau en plein envoi.
  res.once('finish', liberer);
  res.once('close', liberer);
  return null;
}

/**
 * Middleware de réception d'UN fichier (champ `fichier`), vérifié.
 * Pose `req.fichier = { buffer, type, mime, taille, nomOrigine }`.
 * Renvoie une CHAÎNE de middlewares (Express l'aplatit) : limite de débit par
 * utilisateur, réservation mémoire, puis lecture et contrôle du fichier.
 *
 * @param {'image'|'justificatif'|'media'|'document'} famille
 * @param {{ obligatoire?: boolean, champ?: string }} [options]
 */
function recevoirFichier(famille, { obligatoire = true, champ = 'fichier' } = {}) {
  const regle = FAMILLES[famille];
  const transportMax = Math.max(...[...regle.types].map(plafond));
  const instance = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: transportMax, files: 1, fields: 30, fieldSize: 64 * 1024 },
  }).single(champ);

  const reservation = (req, res, next) => {
    // Seul un envoi multipart porte un fichier : une requête JSON (preuve sans
    // capture, par exemple) ne consomme ni mémoire ni place d'envoi simultané.
    if (!req.is('multipart/form-data')) return next();
    const refus = reserverMemoire(req, res, transportMax);
    if (!refus) return next();
    // Corps lu et jeté au fil de l'eau (aucune mémoire retenue), puis réponse.
    if (req.readableEnded || req.complete) return next(refus);
    req.once('end', () => next(refus));
    req.once('error', () => next(refus));
    return req.resume();
  };

  const lecture = (req, res, next) => instance(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new BadRequestError(`Fichier trop volumineux (${enMo(transportMax)} Mo maximum).`, 'FICHIER_TROP_VOLUMINEUX'));
      }
      return next(err);
    }
    if (!req.file) {
      return obligatoire ? next(new BadRequestError(`Fichier manquant : ${regle.libelle} est attendu(e) dans le champ « ${champ} ».`, 'FICHIER_MANQUANT')) : next();
    }
    const type = detecterType(req.file.buffer);
    if (!type || !regle.types.has(type)) {
      return next(new BadRequestError(`Format refusé : ${regle.libelle} est attendu(e).`, 'FORMAT_FICHIER_REFUSE'));
    }
    if (req.file.size > plafond(type)) {
      return next(new BadRequestError(`Fichier trop volumineux (${enMo(plafond(type))} Mo maximum pour ce format).`, 'FICHIER_TROP_VOLUMINEUX'));
    }
    req.fichier = {
      buffer: req.file.buffer,
      type,
      mime: MIME[type],
      taille: req.file.size,
      // multer décode le nom en latin1 : « façade » deviendrait « faÃ§ade ».
      nomOrigine: Buffer.from(String(req.file.originalname || ''), 'latin1').toString('utf8').slice(0, 255),
    };
    return next();
  });

  return [televersementRateLimit, reservation, lecture];
}

module.exports = { recevoirFichier, detecterType, MIME, IMAGES, VIDEOS, etatMemoire };
