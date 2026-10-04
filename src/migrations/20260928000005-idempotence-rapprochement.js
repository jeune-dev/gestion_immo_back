'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * § 51.3 « confirmation reçue deux fois : traitée une seule fois ».
 *
 * Un paiement NON IDENTIFIABLE (sans référence exploitable) n'a pas de ligne
 * `payment_transactions` : il n'existe que dans la file « À rapprocher ».
 * L'identifiant du fournisseur y est gardé dans `details`, et cet index unique
 * garantit qu'une seconde notification du même paiement n'en crée pas une
 * seconde entrée.
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      "CREATE UNIQUE INDEX reconciliation_entries_fournisseur_uq ON reconciliation_entries ((details->>'id_fournisseur')) WHERE details->>'id_fournisseur' IS NOT NULL",
    ]);
  },
  async down(queryInterface) {
    await executer(queryInterface, ['DROP INDEX IF EXISTS reconciliation_entries_fournisseur_uq']);
  },
};
