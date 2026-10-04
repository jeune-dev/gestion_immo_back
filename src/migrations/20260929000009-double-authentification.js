'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Double authentification TOTP (RFC 6238) — OBLIGATOIRE pour le super admin,
 * facultative pour les autres comptes (constat E1 de l'audit de sécurité).
 *
 *   - totp_secret       secret partagé, CHIFFRÉ par l'application (AES-256-GCM) ;
 *                       posé à l'initialisation, actif seulement une fois confirmé ;
 *   - totp_enabled_at   date de confirmation (NULL = double authentification inactive) ;
 *   - totp_last_step    dernier pas de 30 s accepté : un code déjà utilisé ne sert
 *                       jamais deux fois (anti-rejeu, même pendant sa validité) ;
 *   - mfa_recovery_codes empreintes SHA-256 des codes de secours restants (usage unique).
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      'ALTER TABLE users ADD COLUMN totp_secret text',
      'ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz',
      'ALTER TABLE users ADD COLUMN totp_last_step bigint',
      "ALTER TABLE users ADD COLUMN mfa_recovery_codes jsonb NOT NULL DEFAULT '[]'::jsonb",
      // Une double authentification active a forcément un secret.
      'ALTER TABLE users ADD CONSTRAINT users_totp_ck CHECK (totp_enabled_at IS NULL OR totp_secret IS NOT NULL)',
    ]);
  },
  async down(queryInterface) {
    await executer(queryInterface, [
      'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_totp_ck',
      'ALTER TABLE users DROP COLUMN IF EXISTS mfa_recovery_codes',
      'ALTER TABLE users DROP COLUMN IF EXISTS totp_last_step',
      'ALTER TABLE users DROP COLUMN IF EXISTS totp_enabled_at',
      'ALTER TABLE users DROP COLUMN IF EXISTS totp_secret',
    ]);
  },
};
