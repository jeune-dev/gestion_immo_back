'use strict';

/**
 * Calculs monétaires en FCFA ENTIERS.
 *
 * Le franc CFA n'a pas de subdivision en usage : tout montant est un entier.
 * Aucun calcul financier ne passe par des flottants sans arrondi explicite.
 */

/**
 * Répartit `total` proportionnellement aux `poids`, en entiers, de sorte que la
 * somme des parts soit EXACTEMENT `total` (méthode du plus fort reste).
 *
 * Exemple § 16 : 720 000 FCFA sur 12 poids égaux → 12 × 60 000.
 * Avec un reste (100 FCFA / 3) : 34 + 33 + 33 — l'écart d'arrondi est attribué
 * aux plus fortes parties fractionnaires, puis dans l'ordre d'entrée, ce qui
 * rend le calcul déterministe et donc explicable (§ 17).
 *
 * @param {number} total   montant entier ≥ 0
 * @param {number[]} poids poids ≥ 0, au moins un strictement positif
 * @returns {number[]} parts entières, même ordre que `poids`
 */
function repartirProportionnellement(total, poids) {
  if (!Number.isInteger(total) || total < 0) throw new RangeError('Le total doit être un entier positif.');
  if (!Array.isArray(poids) || poids.length === 0) throw new RangeError('Aucun poids de répartition.');
  if (poids.some((p) => !Number.isFinite(p) || p < 0)) throw new RangeError('Poids de répartition invalide.');
  const somme = poids.reduce((a, b) => a + b, 0);
  if (somme <= 0) throw new RangeError('La somme des poids doit être strictement positive.');

  const brutes = poids.map((p) => (total * p) / somme);
  const parts = brutes.map((b) => Math.floor(b));
  let reste = total - parts.reduce((a, b) => a + b, 0);

  const ordre = brutes
    .map((b, i) => ({ i, fraction: b - Math.floor(b) }))
    .sort((a, b) => (b.fraction - a.fraction) || (a.i - b.i));

  for (let k = 0; reste > 0; k = (k + 1) % ordre.length) {
    parts[ordre[k].i] += 1;
    reste -= 1;
  }
  return parts;
}

/** Arrondi à l'entier le plus proche, en refusant les valeurs non finies. */
function entier(valeur) {
  const n = Number(valeur);
  if (!Number.isFinite(n)) throw new RangeError('Montant invalide.');
  return Math.round(n);
}

/** « 350 000 FCFA » — espace insécable fine comme séparateur de milliers. */
function formatFcfa(montant) {
  const n = Math.round(Number(montant) || 0);
  const signe = n < 0 ? '-' : '';
  const chiffres = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${signe}${chiffres} FCFA`;
}

module.exports = { repartirProportionnellement, entier, formatFcfa };
