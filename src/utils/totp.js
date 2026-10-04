'use strict';

const crypto = require('crypto');

/**
 * TOTP (RFC 6238, HMAC-SHA1, pas de 30 s, 6 chiffres) — compatible Google
 * Authenticator, Microsoft Authenticator, Authy, 1Password… Implémenté avec
 * `crypto` seulement : aucune dépendance supplémentaire à auditer.
 */

const PAS_S = 30;
const CHIFFRES = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Octets → Base32 (RFC 4648, sans remplissage), format des applications d'authentification. */
function versBase32(octets) {
  let bits = 0;
  let valeur = 0;
  let sortie = '';
  for (const octet of octets) {
    valeur = (valeur << 8) | octet;
    bits += 8;
    while (bits >= 5) {
      sortie += ALPHABET[(valeur >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) sortie += ALPHABET[(valeur << (5 - bits)) & 31];
  return sortie;
}

/** Base32 → octets ; null si la chaîne n'est pas du Base32 valide. */
function depuisBase32(texte) {
  const propre = String(texte || '').toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  if (!propre || /[^A-Z2-7]/.test(propre)) return null;
  let bits = 0;
  let valeur = 0;
  const octets = [];
  for (const c of propre) {
    valeur = (valeur << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      octets.push((valeur >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(octets);
}

/** Nouveau secret aléatoire de 160 bits (recommandation RFC 4226), en Base32. */
const genererSecret = () => versBase32(crypto.randomBytes(20));

const pasCourant = (maintenant = Date.now()) => Math.floor(maintenant / 1000 / PAS_S);

/** Code à 6 chiffres pour un pas donné (troncature dynamique RFC 4226). */
function codePourPas(secretBase32, pas) {
  const cle = depuisBase32(secretBase32);
  if (!cle) throw new Error('Secret TOTP invalide');
  const compteur = Buffer.alloc(8);
  compteur.writeBigUInt64BE(BigInt(pas));
  const hmac = crypto.createHmac('sha1', cle).update(compteur).digest();
  const decalage = hmac[hmac.length - 1] & 0x0f;
  const binaire = ((hmac[decalage] & 0x7f) << 24) | (hmac[decalage + 1] << 16) | (hmac[decalage + 2] << 8) | hmac[decalage + 3];
  return String(binaire % 10 ** CHIFFRES).padStart(CHIFFRES, '0');
}

/**
 * Vérifie un code : tolérance d'UN pas avant/après (dérive d'horloge du
 * téléphone), comparaison à temps constant. Renvoie le pas reconnu (à
 * enregistrer pour l'anti-rejeu) ou null.
 * @param {string} secretBase32
 * @param {string} code
 * @param {{ maintenant?: number, dernierPas?: number|null }} [o]
 */
function verifier(secretBase32, code, { maintenant = Date.now(), dernierPas = null } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const courant = pasCourant(maintenant);
  let reconnu = null;
  for (const pas of [courant - 1, courant, courant + 1]) {
    const attendu = Buffer.from(codePourPas(secretBase32, pas));
    // Toutes les fenêtres sont calculées et comparées (pas de sortie anticipée).
    if (crypto.timingSafeEqual(attendu, Buffer.from(code)) && reconnu === null) reconnu = pas;
  }
  // Un pas déjà consommé (ou plus ancien) est refusé : anti-rejeu.
  if (reconnu === null || (dernierPas !== null && dernierPas !== undefined && reconnu <= Number(dernierPas))) return null;
  return reconnu;
}

/** URI `otpauth://` à afficher en QR code dans l'application d'authentification. */
function uriOtpauth({ secret, compte, emetteur }) {
  const libelle = encodeURIComponent(`${emetteur}:${compte}`);
  const params = new URLSearchParams({ secret, issuer: emetteur, algorithm: 'SHA1', digits: String(CHIFFRES), period: String(PAS_S) });
  return `otpauth://totp/${libelle}?${params.toString()}`;
}

module.exports = { genererSecret, codePourPas, pasCourant, verifier, uriOtpauth, versBase32, depuisBase32, PAS_S };
