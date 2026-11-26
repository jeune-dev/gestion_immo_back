'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Code d'accès à quatre chiffres des super administrateurs (portail KODAFRIK),
 * demandé après le mot de passe, avant chaque entrée dans le dashboard.
 *
 *   - code_acces_admin : le code haché (bcrypt), jamais en clair, et le
 *     compteur d'échecs (5 → blocage 15 min) ;
 *   - refresh_tokens.code_acces_verifie_le : la SESSION dont le code a été
 *     vérifié ; reprise de rotation en rotation, effacée au changement de code.
 *     Sans elle, /admin répond 403 CODE_ACCES_REQUIS.
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      `CREATE TABLE IF NOT EXISTS code_acces_admin (
        user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        code_hash     varchar(100) NOT NULL,
        echecs        integer NOT NULL DEFAULT 0,
        bloque_jusqua timestamptz,
        modifie_le    timestamptz NOT NULL DEFAULT now(),
        modifie_par   uuid
      )`,
      'ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS code_acces_verifie_le timestamptz',
    ]);
  },

  async down(queryInterface) {
    await executer(queryInterface, [
      'ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS code_acces_verifie_le',
      'DROP TABLE IF EXISTS code_acces_admin',
    ]);
  },
};
