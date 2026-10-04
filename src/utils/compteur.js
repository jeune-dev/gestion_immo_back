'use strict';

const sequelize = require('../config/db.js');

/**
 * Numérotation séquentielle SANS TROU et sans course (travaux #00482,
 * quittances, références de bail et de paiement).
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` est atomique : deux
 * transactions concurrentes obtiennent deux valeurs distinctes. Appelé dans la
 * transaction de l'opération, le numéro est rendu si celle-ci échoue
 * (le verrou de ligne sérialise les appelants jusqu'au COMMIT/ROLLBACK).
 *
 * @param {string} portee  ex. `owner:<uuid>:work_order`
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<number>}
 */
async function prochainNumero(portee, transaction) {
  const [lignes] = await sequelize.query(
    `INSERT INTO counters (scope, value) VALUES (:portee, 1)
     ON CONFLICT (scope) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    { replacements: { portee }, transaction }
  );
  return Number(lignes[0].value);
}

/** Complète à gauche : 482 → « 00482 ». */
const pad = (n, largeur = 5) => String(n).padStart(largeur, '0');

module.exports = { prochainNumero, pad };
