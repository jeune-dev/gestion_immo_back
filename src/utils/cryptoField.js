'use strict';

const crypto = require('crypto');

/**
 * cryptoField.js — chiffrement AES-256-GCM des champs sensibles au repos.
 *
 * Clé : APP_ENC_KEY (32 octets encodés en base64).
 *  - En production : APP_ENC_KEY est OBLIGATOIRE (échec au démarrage si absente).
 *  - En développement : clé dérivée de JWT_SECRET (ne JAMAIS faire ça en prod).
 *
 * Format stocké : "v1:<iv base64>:<tag base64>:<ciphertext base64>".
 * Une valeur qui ne correspond pas à ce format est considérée comme du
 * legacy en clair et retournée telle quelle (pour ne pas casser d'anciennes
 * données lors du déploiement).
 */

let KEY = null;

function getKey() {
  if (KEY) return KEY;

  const raw = process.env.APP_ENC_KEY;
  if (raw) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error('APP_ENC_KEY doit être une chaîne base64 de 32 octets (générer avec : node -e "console.log(crypto.randomBytes(32).toString(\'base64\'))")');
    }
    KEY = buf;
    return KEY;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_ENC_KEY est requise en production (chiffrement des données sensibles au repos).');
  }

  // Dev uniquement : clé déterministe dérivée de JWT_SECRET
  KEY = crypto.createHash('sha256').update(process.env.JWT_SECRET || 'dev-cle-insecure').digest();
  return KEY;
}

/**
 * Chiffre une valeur. Retourne la valeur inchangée si elle est vide.
 * @param {string|null|undefined} plaintext
 * @returns {string|null}
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Déchiffre une valeur chiffrée par encrypt(). Les valeurs legacy en clair
 * sont retournées telles quelles.
 * @param {string|null|undefined} payload
 * @returns {string|null}
 */
function decrypt(payload) {
  if (payload === null || payload === undefined || payload === '') return payload;

  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return payload; // valeur legacy en clair

  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const enc = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (err) {
    // Clé invalide ou donnée corrompue — ne pas faire planter l'application,
    // mais signaler clairement.
    throw new Error('Impossible de déchiffrer un champ chiffré (clé APP_ENC_KEY changée ?).');
  }
}

module.exports = { encrypt, decrypt };
