'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Correctifs de l'audit de sécurité (novembre 2026).
 *
 *   - E2 : `users.phone_verified_at` — posé quand le numéro est prouvé (le
 *     locataire active son compte avec le code reçu sur SON WhatsApp). Les
 *     comptes existants ne sont pas marqués vérifiés : rien ne le prouve.
 *   - M4 : suppression de compte (anonymisation) et durées de conservation.
 *     `users.anonymized_at` trace l'anonymisation ; `tenants.id_document_purged_at`
 *     trace la purge des pièces d'identité un an après la fin du dernier bail.
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      'ALTER TABLE users ADD COLUMN phone_verified_at timestamptz',
      'ALTER TABLE users ADD COLUMN anonymized_at timestamptz',
      'ALTER TABLE tenants ADD COLUMN id_document_purged_at timestamptz',
    ]);
  },

  async down(queryInterface) {
    await executer(queryInterface, [
      'ALTER TABLE tenants DROP COLUMN IF EXISTS id_document_purged_at',
      'ALTER TABLE users DROP COLUMN IF EXISTS anonymized_at',
      'ALTER TABLE users DROP COLUMN IF EXISTS phone_verified_at',
    ]);
  },
};
