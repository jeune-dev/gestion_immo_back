'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Index relevés à l'audit des requêtes des rapports (§ 26, § 45 « écrans
 * rapides avec plusieurs milliers de données ») et idempotence de la
 * synchronisation différée (§ 34) pour les incidents et les états des lieux.
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      // Rapport travaux : recherches par période de création / de clôture.
      'CREATE INDEX work_orders_owner_creation_idx ON work_orders (owner_id, created_at)',
      "CREATE INDEX work_orders_owner_cloture_idx ON work_orders (owner_id, completed_at) WHERE status = 'termine'",
      // Charges refacturées d'une facture (annulation, détail, récupération).
      'CREATE INDEX charges_invoice_idx ON charges (charge_invoice_id)',
      // Rapport locataires : arrivées et départs.
      'CREATE INDEX leases_owner_activation_idx ON leases (owner_id, activated_at) WHERE activated_at IS NOT NULL',
      'CREATE INDEX leases_owner_sortie_idx ON leases (owner_id, ended_on) WHERE ended_on IS NOT NULL',
      // Incident signalé hors ligne puis renvoyé : jamais deux fois.
      'CREATE UNIQUE INDEX incidents_client_reference_uq ON incidents (tenant_id, client_reference) WHERE client_reference IS NOT NULL',
      // États des lieux saisis hors ligne (§ 52.4).
      'ALTER TABLE inspections ADD COLUMN client_reference varchar(64)',
      'CREATE UNIQUE INDEX inspections_client_reference_uq ON inspections (owner_id, client_reference) WHERE client_reference IS NOT NULL',
    ]);
  },
  async down(queryInterface) {
    await executer(queryInterface, [
      'DROP INDEX IF EXISTS inspections_client_reference_uq',
      'ALTER TABLE inspections DROP COLUMN IF EXISTS client_reference',
      'DROP INDEX IF EXISTS incidents_client_reference_uq',
      'DROP INDEX IF EXISTS leases_owner_sortie_idx',
      'DROP INDEX IF EXISTS leases_owner_activation_idx',
      'DROP INDEX IF EXISTS charges_invoice_idx',
      'DROP INDEX IF EXISTS work_orders_owner_cloture_idx',
      'DROP INDEX IF EXISTS work_orders_owner_creation_idx',
    ]);
  },
};
