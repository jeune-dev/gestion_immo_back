'use strict';

const { GRAVITE_ETAT, ELEMENT_ETAT_DES_LIEUX, ETAT_ELEMENT } = require('../../../config/enums.js');
const { normaliser } = require('./trame.service.js');

/**
 * Comparaison automatique entrée / sortie (§ 52.3 étape 5) : « les écarts sont
 * listés élément par élément ». Fonction PURE, testée unitairement.
 *
 * Correspondance : pièce (nom normalisé) + élément + libellé normalisé. Deux
 * éléments identiques dans une même pièce (ex. deux « Portes » sans libellé)
 * sont appariés dans leur ordre d'apparition (suffixe d'occurrence) : la
 * trame étant recopiée à l'identique, l'ordre est stable.
 *
 * Résultat :
 *   - ecarts   : éléments dont l'état s'est AGGRAVÉ (GRAVITE_ETAT), avec les
 *                commentaires et photos des deux états des lieux — ce sont
 *                eux qui peuvent justifier une retenue (§ 52.3 étape 6, § 55) ;
 *   - absents  : présents à l'entrée, introuvables à la sortie ;
 *   - nouveaux : présents à la sortie seulement ;
 *   - resume   : compteurs.
 */

function cle(piece, element, label) {
  return `${normaliser(piece)}|${element}|${normaliser(label)}`;
}

/**
 * Aplati l'arbre pièces → éléments en une table indexée par clé de correspondance.
 * @param {{ rooms: Array<{ name: string, items: Array<object> }> }} edl
 * @returns {Map<string, object>}
 */
function indexer(edl) {
  const index = new Map();
  const occurrences = new Map();
  for (const room of edl?.rooms || []) {
    for (const item of room.items || []) {
      const base = cle(room.name, item.element, item.label);
      const n = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, n);
      index.set(n === 1 ? base : `${base}#${n}`, { piece: room.name, ...item });
    }
  }
  return index;
}

function etat(item) {
  return {
    item_id: item.id ?? null,
    condition: item.condition,
    condition_libelle: ETAT_ELEMENT[item.condition] || item.condition,
    comment: item.comment ?? null,
    photos: item.photos || [],
  };
}

function libelle(item) {
  return {
    piece: item.piece,
    element: item.element,
    element_libelle: ELEMENT_ETAT_DES_LIEUX[item.element] || item.element,
    label: item.label ?? null,
  };
}

/**
 * @param {{ rooms: Array<{ name: string, items: Array<{ id?: string, element: string, label?: string|null, condition: string, comment?: string|null, photos?: any[] }> }> }} entree
 * @param {{ rooms: Array<object> }} sortie
 */
function comparerEtatsDesLieux(entree, sortie) {
  const avant = indexer(entree);
  const apres = indexer(sortie);
  const ecarts = [];
  const absents = [];
  const nouveaux = [];
  let identiques = 0;
  let ameliores = 0;

  for (const [k, itemEntree] of avant) {
    const itemSortie = apres.get(k);
    if (!itemSortie) {
      absents.push({ ...libelle(itemEntree), entree: etat(itemEntree) });
      continue;
    }
    const g1 = GRAVITE_ETAT[itemEntree.condition] ?? 0;
    const g2 = GRAVITE_ETAT[itemSortie.condition] ?? 0;
    if (g2 > g1) {
      ecarts.push({
        ...libelle(itemSortie),
        aggravation: g2 - g1,
        entree: etat(itemEntree),
        sortie: etat(itemSortie),
      });
    } else if (g2 < g1) {
      ameliores += 1;
    } else {
      identiques += 1;
    }
  }
  for (const [k, itemSortie] of apres) {
    if (!avant.has(k)) nouveaux.push({ ...libelle(itemSortie), sortie: etat(itemSortie) });
  }

  // Les écarts les plus graves d'abord : c'est l'ordre de lecture utile au décompte de caution.
  ecarts.sort((a, b) => b.aggravation - a.aggravation);

  return {
    ecarts,
    absents,
    nouveaux,
    resume: {
      elements_entree: avant.size,
      elements_sortie: apres.size,
      ecarts: ecarts.length,
      identiques,
      ameliores,
      absents: absents.length,
      nouveaux: nouveaux.length,
    },
  };
}

module.exports = { comparerEtatsDesLieux, cle };
