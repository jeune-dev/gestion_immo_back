'use strict';

const { Op } = require('sequelize');
const escapeLike = require('./escapeLike.js');

/**
 * Aides de construction des listes (tri, recherche, filtres de période).
 */

/**
 * `-created_at` → [['created_at', 'DESC']]. Le champ a déjà été validé contre
 * une liste blanche par Joi (validations/common.js#tri) ; `correspondances`
 * permet de trier sur une colonne d'une table jointe.
 * Un départage par `id` garantit un ordre stable entre deux pages.
 */
function ordre(tri, defaut, correspondances = {}) {
  const valeur = tri || defaut;
  const desc = valeur.startsWith('-');
  const champ = desc ? valeur.slice(1) : valeur;
  const colonne = correspondances[champ] || [champ];
  return [[...colonne, desc ? 'DESC' : 'ASC'], ['id', 'ASC']];
}

/** Condition ILIKE sur plusieurs colonnes, terme échappé (pas de joker client). */
function rechercheTexte(terme, colonnes) {
  if (!terme) return null;
  const motif = `%${escapeLike(terme)}%`;
  return { [Op.or]: colonnes.map((c) => ({ [c]: { [Op.iLike]: motif } })) };
}

/** Filtre de période [du, au] sur une colonne date. */
function periode(du, au) {
  if (!du && !au) return null;
  const f = {};
  if (du) f[Op.gte] = du;
  if (au) f[Op.lte] = au;
  return f;
}

module.exports = { ordre, rechercheTexte, periode };
