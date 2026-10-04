'use strict';

const sequelize = require('../config/db.js');
const storage = require('../infrastructure/storage.service.js');
const logger = require('../utils/logger.js');

/**
 * Transaction qui NETTOIE les fichiers envoyés au stockage objet si elle
 * échoue.
 *
 * Un fichier est écrit sur R2 avant la ligne `documents` qui le référence (il
 * faut sa clé pour l'insérer). Si la transaction est ensuite annulée — règle
 * métier violée, contrainte SQL, panne — l'objet resterait orphelin, jamais
 * référencé ni supprimé. Chaque clé stockée pendant la transaction est donc
 * enregistrée (`t.clesStockees`) et supprimée en cas d'échec.
 *
 * @template T
 * @param {(t: import('sequelize').Transaction) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function transactionAvecFichiers(fn) {
  const cles = [];
  try {
    return await sequelize.transaction(async (t) => {
      t.clesStockees = cles;
      return fn(t);
    });
  } catch (err) {
    if (cles.length) {
      await Promise.all(cles.map((cle) => storage.supprimer(cle).catch((e) => {
        logger.warn('[transaction] Nettoyage d’un fichier orphelin impossible', { cle, error: e.message });
      })));
    }
    throw err;
  }
}

module.exports = { transactionAvecFichiers };
