'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Sessions (points faibles de l'audit de sécurité) :
 *
 *   - `revoked_reason` : POURQUOI un refresh token a été révoqué. Seule la
 *     réutilisation d'un jeton REMPLACÉ PAR ROTATION trahit un vol ; un vieux
 *     jeton simplement déconnecté ne doit plus fermer toutes les sessions de
 *     la victime (déni de service par jeton périmé) ;
 *   - `session_started_at` : début de la SESSION, transmis de rotation en
 *     rotation — une durée maximale absolue devient applicable (une session
 *     renouvelée tous les 30 jours vivait jusqu'ici indéfiniment).
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      `ALTER TABLE refresh_tokens ADD COLUMN revoked_reason varchar(20)
         CHECK (revoked_reason IN ('rotation', 'deconnexion', 'plafond', 'distante', 'globale', 'rejeu', 'expiration'))`,
      'ALTER TABLE refresh_tokens ADD COLUMN session_started_at timestamptz',
      'UPDATE refresh_tokens SET session_started_at = created_at WHERE session_started_at IS NULL',
      "UPDATE refresh_tokens SET revoked_reason = 'rotation' WHERE revoked_at IS NOT NULL AND revoked_reason IS NULL",
      'ALTER TABLE refresh_tokens ALTER COLUMN session_started_at SET DEFAULT now()',
      'ALTER TABLE refresh_tokens ALTER COLUMN session_started_at SET NOT NULL',
    ]);
  },
  async down(queryInterface) {
    await executer(queryInterface, [
      'ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS session_started_at',
      'ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS revoked_reason',
    ]);
  },
};
