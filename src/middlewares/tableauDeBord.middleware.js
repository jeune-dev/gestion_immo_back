'use strict';

const { invaliderTableauDeBord } = require('../utils/cache.js');

/**
 * Après une écriture réussie de l'espace propriétaire, oublie les chiffres en
 * cache AVANT d'envoyer la réponse : le client qui relit aussitôt voit le bon résultat.
 */
const METHODES_LECTURE = new Set(['GET', 'HEAD', 'OPTIONS']);

const rafraichirTableauDeBord = (req, res, next) => {
  if (METHODES_LECTURE.has(req.method)) return next();
  const envoyer = res.json.bind(res);
  res.json = (corps) => {
    if (res.statusCode >= 400) return envoyer(corps);
    invaliderTableauDeBord(req.ownerId).finally(() => envoyer(corps));
    return res;
  };
  return next();
};

module.exports = rafraichirTableauDeBord;
