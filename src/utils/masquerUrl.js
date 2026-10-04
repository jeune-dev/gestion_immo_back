'use strict';

/**
 * URL d'une requête, débarrassée des SECRETS qu'elle peut porter — pour les
 * journaux d'accès (morgan) et d'erreurs (reprise de Widjila).
 *
 * Le lien d'activation d'un locataire (`/activation/:jeton`) EST son propre
 * secret ; un jeton passé en paramètre de requête aussi. Les journaux les
 * conservaient en clair pour toute leur durée de rétention. On masque la
 * valeur, pas la route : le journal garde son utilité.
 */
const MOTIFS = [
  [/(\/activation\/)[^/?#]+/g, '$1[masqué]'],
  [/([?&](?:token|token_payment|refreshToken|refresh_token|otp|code|hub\.verify_token|signature)=)[^&#]*/gi, '$1[masqué]'],
];

/**
 * @param {string} url
 * @returns {string}
 */
function masquerUrl(url) {
  let resultat = String(url || '');
  for (const [motif, remplacement] of MOTIFS) resultat = resultat.replace(motif, remplacement);
  return resultat;
}

module.exports = masquerUrl;
