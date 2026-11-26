'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Double authentification SUPPRIMÉE pour tous les profils : la connexion
 * n'ouvre plus d'étape « code » (l'entrée du back-office KODAFRIK est protégée
 * par son code d'accès à quatre chiffres). Les secrets TOTP et codes de
 * secours encore en base sont effacés : plus rien ne les lit.
 *
 * Les colonnes restent (une réactivation n'aurait pas à les recréer).
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      "UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, mfa_recovery_codes = '[]'::jsonb "
        + 'WHERE totp_secret IS NOT NULL OR totp_enabled_at IS NOT NULL',
    ]);
  },

  // Les secrets effacés ne se restaurent pas : rien à défaire.
  async down() {},
};
