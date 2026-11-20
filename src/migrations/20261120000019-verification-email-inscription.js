'use strict';

/**
 * Vérification de l'adresse e-mail AVANT la création du compte (§ 5).
 *
 * L'inscription se fait en deux temps : un code à 6 chiffres part à l'adresse
 * saisie, et le compte n'est créé qu'une fois ce code vérifié. La ligne ne peut
 * donc pas porter de `user_id` — l'utilisateur n'existe pas encore : la clé est
 * l'adresse elle-même. Le code n'est jamais stocké en clair, seulement son
 * empreinte HMAC, comme pour `password_resets`.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE email_verifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar(254) NOT NULL,
        code_hash char(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        attempts smallint NOT NULL DEFAULT 0,
        verified_at timestamptz,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    // Recherche de la demande en cours pour une adresse (insensible à la casse)
    // et ménage des lignes périmées : le même index sert les deux.
    await queryInterface.sequelize.query(
      'CREATE INDEX email_verifications_email_idx ON email_verifications (lower(email), expires_at DESC)'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS email_verifications');
  },
};
