'use strict';

const { PlatformSetting, Owner } = require('../../../models/index.js');
const { DEFAUTS_PLATEFORME, parametresProprietaire } = require('../../../config/parametres.js');
const cache = require('../../../utils/cache.js');

/**
 * Lecture des paramètres plateforme (super admin) et propriétaire, avec cache
 * court : ils sont lus par les jobs et par des routes fréquentes (paiement,
 * invitation) mais ne changent presque jamais.
 */

const TTL_S = 60;

async function plateforme(cle) {
  const cleCache = `parametres:plateforme:${cle}`;
  const enCache = await cache.lire(cleCache);
  if (enCache) return enCache;
  const ligne = await PlatformSetting.findByPk(cle);
  const valeur = { ...(DEFAUTS_PLATEFORME[cle] || {}), ...(ligne?.value || {}) };
  await cache.ecrire(cleCache, valeur, TTL_S);
  return valeur;
}

async function invaliderPlateforme(cle) {
  await cache.invalider(`parametres:plateforme:${cle}`);
}

/** Paramètres effectifs d'un propriétaire. */
async function proprietaire(ownerId, transaction) {
  const owner = await Owner.findByPk(ownerId, { attributes: ['id', 'settings'], transaction });
  return parametresProprietaire(owner);
}

module.exports = { plateforme, invaliderPlateforme, proprietaire };
