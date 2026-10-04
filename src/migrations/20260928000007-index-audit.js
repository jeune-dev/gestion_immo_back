'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Index relevés à l'audit (§ 45 « écrans rapides avec plusieurs milliers de
 * données ») :
 *   - liste des artisans (§ 24) : le total dépensé est une sous-requête
 *     corrélée PAR ARTISAN sur `expenses.contractor_id` (dépenses valides
 *     seulement) — sans index, un parcours de toute la table par ligne ;
 *   - annulation d'une facture commune (§ 16, § 51.3) : recherche des
 *     transactions de paiement visant ses charges (`charge_id`, rare : index
 *     partiel sur les seules lignes qui visent une charge).
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      "CREATE INDEX expenses_contractor_idx ON expenses (contractor_id) WHERE status = 'valide'",
      'CREATE INDEX payment_transactions_charge_idx ON payment_transactions (charge_id) WHERE charge_id IS NOT NULL',
    ]);
  },
  async down(queryInterface) {
    await executer(queryInterface, [
      'DROP INDEX IF EXISTS payment_transactions_charge_idx',
      'DROP INDEX IF EXISTS expenses_contractor_idx',
    ]);
  },
};
