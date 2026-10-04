'use strict';

const { encrypt, decrypt } = require('../utils/cryptoField.js');

/**
 * Chiffrement au repos de données personnelles restées en clair (constat M13
 * de l'audit de sécurité) :
 *   - `tenants.notes`                     texte libre du bailleur (peut contenir
 *                                          santé, situation familiale, litiges…) ;
 *   - `payment_transactions.payer_phone`  numéro du payeur mobile money ;
 *   - `reconciliation_entries.payer_phone`.
 * Aucune de ces colonnes ne sert de critère de recherche : le chiffrement
 * (AES-256-GCM, APP_ENC_KEY, utils/cryptoField.js) ne casse aucune requête.
 * Les colonnes de téléphone passent en `text` (un chiffré dépasse 20 caractères).
 *
 * Les valeurs existantes sont chiffrées ici, par lots ; une valeur déjà
 * chiffrée (préfixe « v1: ») n'est pas touchée : migration rejouable.
 */

const COLONNES = [
  ['tenants', 'notes'],
  ['payment_transactions', 'payer_phone'],
  ['reconciliation_entries', 'payer_phone'],
];
const LOT = 500;

async function transformer(queryInterface, table, colonne, fn, clause) {
  const sequelize = queryInterface.sequelize;
  let dernier = null;
  for (;;) {
    const [lignes] = await sequelize.query(
      `SELECT id, "${colonne}" AS valeur FROM "${table}"
        WHERE "${colonne}" IS NOT NULL AND ${clause} ${dernier ? 'AND id > :dernier' : ''}
        ORDER BY id LIMIT ${LOT}`,
      { replacements: { dernier } }
    );
    if (!lignes.length) return;
    for (const { id, valeur } of lignes) {
      await sequelize.query(`UPDATE "${table}" SET "${colonne}" = :v WHERE id = :id`, { replacements: { v: fn(valeur), id } });
    }
    dernier = lignes[lignes.length - 1].id;
  }
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE payment_transactions ALTER COLUMN payer_phone TYPE text');
    await queryInterface.sequelize.query('ALTER TABLE reconciliation_entries ALTER COLUMN payer_phone TYPE text');
    for (const [table, colonne] of COLONNES) {
      await transformer(queryInterface, table, colonne, encrypt, `"${colonne}" NOT LIKE 'v1:%'`);
    }
  },
  async down(queryInterface) {
    for (const [table, colonne] of COLONNES) {
      await transformer(queryInterface, table, colonne, decrypt, `"${colonne}" LIKE 'v1:%'`);
    }
    await queryInterface.sequelize.query('ALTER TABLE payment_transactions ALTER COLUMN payer_phone TYPE varchar(20)');
    await queryInterface.sequelize.query('ALTER TABLE reconciliation_entries ALTER COLUMN payer_phone TYPE varchar(20)');
  },
};
