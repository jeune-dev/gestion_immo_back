'use strict';

/**
 * Reprise d'une rotation dont la réponse s'est perdue (coupure réseau, application
 * fermée avant l'écriture du jeton). `replaced_by_id` relie un refresh token à son
 * successeur : tant que celui-ci n'a jamais servi, présenter l'ancien jeton n'est
 * pas un vol mais un client qui n'a rien reçu.
 */
const MOTIFS = ['rotation', 'deconnexion', 'plafond', 'distante', 'globale', 'rejeu', 'expiration'];
const liste = (motifs) => motifs.map((m) => `'${m}'`).join(', ');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const sql of [
        'ALTER TABLE refresh_tokens ADD COLUMN replaced_by_id uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL',
        'ALTER TABLE refresh_tokens DROP CONSTRAINT refresh_tokens_revoked_reason_check',
        `ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_revoked_reason_check CHECK (revoked_reason IN (${liste([...MOTIFS, 'reprise'])}))`,
      ]) await queryInterface.sequelize.query(sql, { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const sql of [
        "UPDATE refresh_tokens SET revoked_reason = 'rotation' WHERE revoked_reason = 'reprise'",
        'ALTER TABLE refresh_tokens DROP CONSTRAINT refresh_tokens_revoked_reason_check',
        `ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_revoked_reason_check CHECK (revoked_reason IN (${liste(MOTIFS)}))`,
        'ALTER TABLE refresh_tokens DROP COLUMN replaced_by_id',
      ]) await queryInterface.sequelize.query(sql, { transaction });
    });
  },
};
