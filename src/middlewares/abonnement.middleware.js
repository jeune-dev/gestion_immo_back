'use strict';

const droits = require('../modules/abonnement/service/droits.service.js');

/**
 * Garde d'abonnement de l'espace propriétaire (§ 31).
 *
 * Lecture (GET) toujours permise ; toute écriture exige un abonnement actif
 * (essai ou payé, non échu). Monté sur chaque routeur de l'espace
 * propriétaire, après `auth` et `requireProprietaire`.
 */
const exigerAbonnementPourEcrire = async (req, res, next) => {
  try {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    droits.exigerActif(await droits.etat(req.ownerId));
    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * La fonctionnalité doit être incluse dans le plan du propriétaire. En
 * lecture (GET, HEAD), un abonnement échu ou suspendu n'empêche pas la
 * consultation (§ 31 « lecture seule ») ; une écriture exige l'abonnement actif.
 */
const exigerFonctionnalite = (code) => async (req, res, next) => {
  try {
    const lecture = req.method === 'GET' || req.method === 'HEAD';
    await droits.exigerFonctionnalite(req.ownerId, code, { lecture });
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = { exigerAbonnementPourEcrire, exigerFonctionnalite };
