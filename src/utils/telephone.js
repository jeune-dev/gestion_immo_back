'use strict';

/**
 * Normalisation des numéros de téléphone au format E.164.
 *
 * Le téléphone sert d'identifiant de connexion (§ 5) et de destinataire
 * WhatsApp (§ 54) : « 77 123 45 67 », « 0022177… » et « +221 77… » doivent
 * désigner le même compte. Sans indicatif, l'indicatif par défaut
 * (`DEFAULT_COUNTRY_CODE`, 221 = Sénégal) est ajouté.
 */

const INDICATIF_DEFAUT = String(process.env.DEFAULT_COUNTRY_CODE || '221').replace(/\D/g, '');

/**
 * @param {string|null|undefined} brut
 * @returns {string|null} « +221771234567 », ou null si inexploitable
 */
function normaliserTelephone(brut) {
  if (brut === null || brut === undefined) return null;
  let chiffres = String(brut).trim();
  if (!chiffres) return null;

  const international = chiffres.startsWith('+') || chiffres.startsWith('00');
  chiffres = chiffres.replace(/\D/g, '');
  if (chiffres.startsWith('00')) chiffres = chiffres.slice(2);

  if (!international) {
    // Numéro national : on retire un éventuel 0 de tête (usage de certains pays).
    chiffres = chiffres.replace(/^0+/, '');
    if (!chiffres.startsWith(INDICATIF_DEFAUT) || chiffres.length <= 9) {
      chiffres = `${INDICATIF_DEFAUT}${chiffres}`;
    }
  }

  // E.164 : 8 à 15 chiffres, indicatif compris.
  if (chiffres.length < 8 || chiffres.length > 15) return null;
  return `+${chiffres}`;
}

/** Numéro masqué pour les journaux et l'affichage partiel : +22177•••••67 */
function masquerTelephone(tel) {
  if (!tel) return tel;
  const s = String(tel);
  if (s.length <= 6) return '•••';
  return `${s.slice(0, 6)}${'•'.repeat(Math.max(0, s.length - 8))}${s.slice(-2)}`;
}

module.exports = { normaliserTelephone, masquerTelephone, INDICATIF_DEFAUT };
