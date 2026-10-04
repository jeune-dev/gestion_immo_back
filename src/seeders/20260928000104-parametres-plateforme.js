'use strict';

const { DEFAUTS_PLATEFORME } = require('../config/parametres.js');

/** Paramètres plateforme initiaux (§ 30 « Paramètres »), modifiables par le Super Admin. */
const DESCRIPTIONS = {
  essai: "Formule et durée de la période d'essai offerte à l'inscription d'un propriétaire",
  invitation: "Durée de validité d'une invitation locataire",
  otp: 'Durée de validité et nombre d’essais du code de réinitialisation de mot de passe',
  paiement: 'Délai après lequel une demande de paiement non aboutie expire',
};

module.exports = {
  async up(queryInterface) {
    for (const [cle, valeur] of Object.entries(DEFAUTS_PLATEFORME)) {
      await queryInterface.sequelize.query(
        `INSERT INTO platform_settings (key, value, description) VALUES (:cle, CAST(:valeur AS jsonb), :description)
         ON CONFLICT (key) DO NOTHING`,
        { replacements: { cle, valeur: JSON.stringify(valeur), description: DESCRIPTIONS[cle] || null } }
      );
    }
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DELETE FROM platform_settings');
  },
};
