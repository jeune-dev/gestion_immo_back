'use strict';

/**
 * Photo de couverture d'un immeuble, choisie par le propriétaire parmi ses
 * photos : affichée dans ses listes et sur l'accueil du locataire.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('buildings', 'cover_document_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'documents', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('buildings', 'cover_document_id');
  },
};
