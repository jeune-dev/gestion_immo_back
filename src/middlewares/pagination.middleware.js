'use strict';

const { ValidationError } = require('../errors/AppError.js');

/**
 * Pagination normalisée, VALIDÉE et plafonnée (reprise de Widjila, durcie).
 *
 * `?limit=500000` ne doit jamais atteindre `findAndCountAll` : une seule
 * requête suffirait à saturer la base et la mémoire du process.
 *
 * Règles UNIFORMES pour toutes les listes de l'API :
 *   - `page` et `limit` absents → page 1, taille par défaut ;
 *   - valeur non entière, nulle ou négative → 422 PAGINATION_INVALIDE (une
 *     valeur fausse n'est plus corrigée en silence : le client apprend son
 *     erreur au lieu de recevoir une autre page que celle demandée) ;
 *   - `limit` au-delà du plafond → ramenée au plafond (100) ;
 *   - `page` au-delà de PAGE_MAX → ramenée à PAGE_MAX (OFFSET borné : un
 *     `?page=1e9` ferait scanner toute la table) ;
 *   - page au-delà des résultats → liste vide, total exact.
 *
 * Les valeurs sont lues dans la chaîne de requête BRUTE : une validation Joi
 * de la route qui ne déclarerait pas `page` / `limit` ne peut pas les masquer.
 * Résultat exposé dans `req.pagination = { page, limit, offset }`.
 */

const LIMITE_MAX = 100;
const LIMITE_DEFAUT = 20;
const PAGE_MAX = 5000;

/** Dernière valeur brute d'un paramètre de la chaîne de requête (ou undefined). */
function brut(req, nom) {
  const texte = (req.originalUrl || req.url || '').split('?')[1];
  if (!texte) return undefined;
  const valeurs = new URLSearchParams(texte).getAll(nom);
  return valeurs.length ? valeurs[valeurs.length - 1] : undefined;
}

/** @returns {number|null|undefined} entier ≥ 1, null si invalide, undefined si absent */
function entierPositif(valeur) {
  if (valeur === undefined || valeur === '') return undefined;
  if (!/^\d{1,9}$/.test(String(valeur).trim())) return null;
  const n = Number(valeur);
  return n >= 1 ? n : null;
}

const paginate = ({ max = LIMITE_MAX, defaut = LIMITE_DEFAUT } = {}) => {
  const plafond = Math.min(max, LIMITE_MAX);
  const parDefaut = Math.min(defaut, plafond);

  return (req, res, next) => {
    const page = entierPositif(brut(req, 'page'));
    const limit = entierPositif(brut(req, 'limit'));
    const erreurs = [];
    if (page === null) erreurs.push('"page" doit être un entier supérieur ou égal à 1');
    if (limit === null) erreurs.push('"limit" doit être un entier supérieur ou égal à 1');
    if (erreurs.length) return next(new ValidationError('Pagination invalide', erreurs, 'PAGINATION_INVALIDE'));

    const p = Math.min(page ?? 1, PAGE_MAX);
    const l = Math.min(limit ?? parDefaut, plafond);
    req.pagination = { page: p, limit: l, offset: (p - 1) * l };
    return next();
  };
};

module.exports = paginate;
module.exports.LIMITE_MAX = LIMITE_MAX;
module.exports.PAGE_MAX = PAGE_MAX;
