'use strict';

const crypto = require('crypto');

/**
 * Comparaison à temps constant tolérante aux entrées invalides (reprise de
 * Widjila) : `timingSafeEqual` lève sur des longueurs différentes, ce qui
 * transformait une signature fausse en erreur 500 sur une route publique.
 */
function comparerTempsConstant(attendu, recu) {
  if (typeof attendu !== 'string' || typeof recu !== 'string' || !attendu || !recu) return false;
  const a = Buffer.from(attendu, 'utf8');
  const b = Buffer.from(recu, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { comparerTempsConstant };
