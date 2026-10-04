'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger.js');
const r2 = require('./r2.service.js');

/**
 * Stockage objet (§ 38 « stockage objet : photos, contrats, justificatifs,
 * documents ») — repris de Widjila.
 *
 * - Cloudflare R2 (bucket PRIVÉ) dès que les variables R2_* sont définies ;
 *   sinon disque local (développement, tests).
 * - Seule la CLÉ est stockée en base (`documents.storage_key`), jamais une URL
 *   publique : tout accès repasse par l'API, qui contrôle les droits (§ 37
 *   « URL sécurisée »). Une URL signée de courte durée peut être délivrée à la
 *   demande (téléchargement direct depuis R2).
 * - Le nom de l'objet est aléatoire : aucune information (nom du locataire,
 *   type de pièce) ne fuit par la clé.
 */

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '..', '..', 'uploads');

const CLE_VALIDE = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*\/[0-9]{13}-[0-9a-f]{24}\.[a-z0-9]{2,5}$/;

/**
 * Enregistre un contenu et retourne sa clé.
 * @param {Buffer} buffer
 * @param {string} dossier  ex. `owners/<uuid>/travaux`
 * @param {string} extension sans point (déduite du contenu réel)
 * @param {string} mime
 * @returns {Promise<string>} clé de l'objet
 */
async function enregistrer(buffer, dossier, extension, mime) {
  const propre = String(dossier).toLowerCase().replace(/[^a-z0-9/_-]/g, '').replace(/^\/+|\/+$/g, '');
  const cle = `${propre}/${Date.now()}-${crypto.randomBytes(12).toString('hex')}.${extension}`;

  if (r2.estConfigure()) {
    await r2.upload(buffer, cle, `x.${extension}`);
    return cle;
  }

  const absolu = cheminLocal(cle);
  await fsp.mkdir(path.dirname(absolu), { recursive: true });
  await fsp.writeFile(absolu, buffer);
  return cle;
}

/** Chemin disque d'une clé, avec garde anti-traversée. */
function cheminLocal(cle) {
  if (!CLE_VALIDE.test(cle)) throw new Error('Clé de stockage invalide');
  const absolu = path.join(UPLOAD_DIR, ...cle.split('/'));
  if (!absolu.startsWith(UPLOAD_DIR + path.sep)) throw new Error('Clé de stockage invalide');
  return absolu;
}

/**
 * Ouvre un objet en lecture (flux).
 * @returns {Promise<{ stream: NodeJS.ReadableStream, taille?: number }|null>}
 */
async function ouvrir(cle) {
  if (!cle || !CLE_VALIDE.test(cle)) return null;
  if (r2.estConfigure()) {
    try {
      const { stream, taille } = await r2.getStream(cle);
      return { stream, taille };
    } catch (err) {
      logger.warn(`[storage] Objet introuvable sur R2 : ${cle}`, { error: err.name || err.message });
      return null;
    }
  }
  try {
    const absolu = cheminLocal(cle);
    const stat = await fsp.stat(absolu);
    return { stream: fs.createReadStream(absolu), taille: stat.size };
  } catch {
    return null;
  }
}

/** Contenu complet en mémoire (génération de PDF avec photos). */
async function lire(cle) {
  const objet = await ouvrir(cle);
  if (!objet) return null;
  const morceaux = [];
  for await (const m of objet.stream) morceaux.push(m);
  return Buffer.concat(morceaux);
}

/** Suppression best-effort (fichier orphelin après échec d'une transaction). */
async function supprimer(cle) {
  if (!cle || !CLE_VALIDE.test(cle)) return;
  if (r2.estConfigure()) {
    await r2.supprimer(cle);
    return;
  }
  try {
    await fsp.unlink(cheminLocal(cle));
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`[storage] Suppression locale impossible : ${err.message}`);
  }
}

/** URL signée temporaire (R2 uniquement) ; null sinon. */
async function urlTemporaire(cle, secondes = 300) {
  if (!r2.estConfigure() || !CLE_VALIDE.test(cle)) return null;
  return r2.urlSignee(cle, secondes);
}

function ensureUploadDir() {
  if (!r2.estConfigure() && !fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

async function ping() {
  return r2.ping();
}

module.exports = { enregistrer, ouvrir, lire, supprimer, urlTemporaire, ensureUploadDir, ping, UPLOAD_DIR };
