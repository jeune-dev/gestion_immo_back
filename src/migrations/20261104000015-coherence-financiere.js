'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Cohérence financière :
 *   - `charge_allocations.provision_deducted` : provision de charges déjà
 *     appelée et déduite de la part refacturée ; chaque provision ne sert qu'une fois ;
 *   - `deposit_transactions.rent_payment_id` : paiement créé par une retenue de
 *     caution pour loyer ou charges impayés ;
 *   - une seule dépense valide par facture commune répartie.
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      'ALTER TABLE charge_allocations ADD COLUMN provision_deducted bigint NOT NULL DEFAULT 0 CHECK (provision_deducted >= 0 AND provision_deducted <= amount)',
      'ALTER TABLE deposit_transactions ADD COLUMN rent_payment_id uuid REFERENCES rent_payments(id)',
      "CREATE UNIQUE INDEX expenses_facture_commune_uq ON expenses (charge_invoice_id) WHERE charge_invoice_id IS NOT NULL AND status <> 'annulee'",
    ]);
  },
  async down(queryInterface) {
    await executer(queryInterface, [
      'DROP INDEX IF EXISTS expenses_facture_commune_uq',
      'ALTER TABLE deposit_transactions DROP COLUMN IF EXISTS rent_payment_id',
      'ALTER TABLE charge_allocations DROP COLUMN IF EXISTS provision_deducted',
    ]);
  },
};
