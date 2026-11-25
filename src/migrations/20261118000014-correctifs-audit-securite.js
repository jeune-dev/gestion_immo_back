'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Correctifs de l'audit de sécurité (novembre 2026).
 *
 *   - E2 : vérification du téléphone par code WhatsApp. Table
 *     `phone_verifications` (codes à usage unique, empreinte HMAC seulement,
 *     essais plafonnés) et `users.phone_verified_at`. Les comptes existants ne
 *     sont pas marqués vérifiés : rien ne prouve qu'ils l'ont été.
 *   - M4 : suppression de compte (anonymisation) et durées de conservation.
 *     `users.anonymized_at` trace l'anonymisation ; `tenants.id_document_purged_at`
 *     trace la purge des pièces d'identité un an après la fin du dernier bail.
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      `CREATE TABLE phone_verifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        phone varchar(20) NOT NULL,
        purpose varchar(30) NOT NULL CHECK (purpose IN ('inscription')),
        code_hash char(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX phone_verifications_recherche_idx ON phone_verifications (phone, purpose, created_at DESC) WHERE used_at IS NULL',
      'CREATE INDEX phone_verifications_purge_idx ON phone_verifications (expires_at)',
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
      'DROP TABLE IF EXISTS phone_verifications',
    ]);
  },
};
