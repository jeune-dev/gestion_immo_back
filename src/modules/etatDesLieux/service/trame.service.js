'use strict';

/**
 * Trame de pièces proposée à la création d'un état des lieux (§ 52.3 étape 1 :
 * « une trame de pièces est proposée selon le type d'appartement »).
 *
 * Fonctions PURES (aucun accès base) : testées unitairement, et réutilisées
 * pour les éléments par défaut d'une pièce ajoutée à la main.
 *
 * Éléments par pièce (§ 52.2) : murs, sols, plafond, portes, fenêtres,
 * électricité — plus plomberie pour les pièces d'eau, sanitaires pour salles
 * de bain / WC, et mobilier si le logement est meublé.
 */

const TYPES_PROFESSIONNELS = new Set(['local_commercial', 'bureau', 'magasin']);

/** Nombre de pièces principales retenu quand l'appartement ne le précise pas. */
const PIECES_PAR_DEFAUT = Object.freeze({
  studio: 1, chambre: 1, f1: 1, f2: 2, f3: 3, f4: 4, f5: 5, duplex: 4, villa: 5, autre: 2,
});

// Garde-fou : un rooms_count aberrant ne doit pas générer des centaines de lignes.
const PIECES_MAX = 15;

const BASE = ['murs', 'sols', 'plafond', 'portes', 'fenetres', 'electricite'];

/**
 * Nature d'une pièce déduite de son nom — sert aux pièces de la trame comme
 * aux pièces ajoutées à la main (« Salle d'eau 2 », « Toilettes invités »).
 * @returns {'sanitaire'|'eau'|'exterieur'|'reserve'|'principale'}
 */
function naturePiece(nom) {
  const n = normaliser(nom);
  if (/(salle de bain|salle d eau|\bwc\b|toilette|sanitaire|douche)/.test(n)) return 'sanitaire';
  if (/(cuisine|buanderie|kitchenette)/.test(n)) return 'eau';
  if (/(balcon|terrasse|jardin|cour|garage|parking)/.test(n)) return 'exterieur';
  if (/(reserve|debarras|cave|stock)/.test(n)) return 'reserve';
  return 'principale';
}

/**
 * Éléments proposés pour une pièce.
 * @param {string} nom
 * @param {boolean} meuble
 * @returns {Array<{ element: string, label: string|null }>}
 */
function elementsParDefaut(nom, meuble = false) {
  const nature = naturePiece(nom);
  let elements;
  if (nature === 'sanitaire') elements = [...BASE, 'plomberie', 'sanitaires'];
  else if (nature === 'eau') elements = [...BASE, 'plomberie'];
  else if (nature === 'exterieur') elements = ['murs', 'sols', 'portes', 'electricite'];
  else if (nature === 'reserve') elements = ['murs', 'sols', 'plafond', 'portes', 'electricite'];
  else elements = [...BASE];
  // Le mobilier n'a de sens que dans les pièces de vie et la cuisine d'un meublé.
  if (meuble && (nature === 'principale' || nature === 'eau')) elements.push('mobilier');
  return elements.map((element) => ({ element, label: null }));
}

function nombrePieces(type, roomsCount) {
  const n = Number.isInteger(roomsCount) && roomsCount > 0 ? roomsCount : (PIECES_PAR_DEFAUT[type] || PIECES_PAR_DEFAUT.autre);
  return Math.min(n, PIECES_MAX);
}

function nomsResidentiels(type, pieces) {
  if (type === 'chambre') return ['Chambre', "Salle d'eau / WC"];
  const noms = [];
  if (pieces <= 1) {
    noms.push('Pièce principale');
  } else {
    noms.push('Salon / Séjour');
    const chambres = pieces - 1;
    for (let i = 1; i <= chambres; i += 1) noms.push(chambres === 1 ? 'Chambre' : `Chambre ${i}`);
  }
  noms.push('Cuisine');
  if (type === 'studio' || type === 'f1') {
    noms.push("Salle d'eau / WC");
  } else {
    noms.push('Salle de bain', 'WC');
    noms.push('Balcon / Terrasse');
  }
  return noms;
}

function nomsProfessionnels(type, pieces) {
  const noms = ['Local principal'];
  // Un bureau de plusieurs pièces : chaque bureau est inspecté séparément.
  if (type === 'bureau') for (let i = 2; i <= pieces; i += 1) noms.push(`Bureau ${i}`);
  noms.push('Réserve', 'Sanitaires');
  return noms;
}

/**
 * Trame complète d'un appartement.
 * @param {string} type        TYPE_APPARTEMENT
 * @param {number|null} roomsCount
 * @param {boolean} [meuble]
 * @returns {Array<{ name: string, position: number, items: Array<{ element: string, label: string|null, position: number }> }>}
 */
function trameDesPieces(type, roomsCount, meuble = false) {
  const pieces = nombrePieces(type, roomsCount);
  const noms = TYPES_PROFESSIONNELS.has(type) ? nomsProfessionnels(type, pieces) : nomsResidentiels(type, pieces);
  return noms.map((name, position) => ({
    name,
    position,
    items: elementsParDefaut(name, meuble).map((e, i) => ({ ...e, position: i })),
  }));
}

/**
 * Normalisation d'un libellé : minuscules, sans accents ni ponctuation,
 * espaces réduits. « Salon/Séjour » et « salon - séjour » se correspondent
 * (comparaison entrée / sortie, § 52.3 étape 5).
 */
function normaliser(texte) {
  return String(texte ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

module.exports = { trameDesPieces, elementsParDefaut, naturePiece, normaliser, PIECES_MAX };
