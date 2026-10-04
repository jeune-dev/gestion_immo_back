'use strict';

const enums = require('../../../config/enums.js');

/**
 * Référentiels publics : toutes les énumérations de `config/enums.js`, source
 * unique des codes ET des libellés. Le mobile et le web les lisent au
 * démarrage : aucun libellé n'est dupliqué côté client, et une évolution d'une
 * énumération (nouvelle migration) est visible sans nouvelle version de
 * l'application.
 *
 * Deux familles :
 *   - `enumerations` : code → libellé, exposées en tableaux ordonnés
 *     `[{ code, label }]` (l'ordre de déclaration est l'ordre d'affichage) ;
 *   - `correspondances` : tables code → nombre (mois par périodicité, gravité
 *     d'un état d'élément) exposées telles quelles — ce ne sont pas des listes
 *     de choix mais des règles de calcul que le client peut réutiliser.
 *
 * Contenu figé au chargement du module : les énumérations sont des constantes
 * gelées, recalculer la réponse à chaque appel ne servirait à rien.
 */

const cleApi = (nom) => nom.toLowerCase();

function construire() {
  const enumerations = {};
  const correspondances = {};
  for (const [nom, valeur] of Object.entries(enums)) {
    if (typeof valeur !== 'object' || valeur === null) continue; // `codes` (fonction)
    const entrees = Object.entries(valeur);
    if (entrees.every(([, libelle]) => typeof libelle === 'string')) {
      enumerations[cleApi(nom)] = entrees.map(([code, label]) => ({ code, label }));
    } else {
      correspondances[cleApi(nom)] = { ...valeur };
    }
  }
  return Object.freeze({ enumerations, correspondances });
}

const REFERENTIELS = construire();

function tous() {
  return REFERENTIELS;
}

module.exports = { tous };
