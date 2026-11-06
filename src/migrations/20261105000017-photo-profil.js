'use strict';

/**
 * Photo de profil gardée par le serveur : l'application ne stocke plus aucune
 * donnée sur le téléphone. `avatar_updated_at` dit au client qu'une photo existe
 * et quand la recharger ; la clé de stockage ne sort jamais de l'API.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'avatar_key', { type: Sequelize.STRING(300), allowNull: true });
    await queryInterface.addColumn('users', 'avatar_updated_at', { type: Sequelize.DATE, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'avatar_updated_at');
    await queryInterface.removeColumn('users', 'avatar_key');
  },
};
