'use strict';

/**
 * Catégories de dépenses globales (§ 20, § 21). Chaque catégorie est rangée
 * dans un groupe de sorties de caisse du § 21 (Travaux, Entretien, Factures,
 * Nettoyage, Sécurité, Autres dépenses). Le Super Admin les administre (§ 30
 * « Catégories ») ; un propriétaire peut ajouter les siennes.
 */
const CATEGORIES = [
  ['travaux', 'Travaux', 'travaux', 1],
  ['plomberie', 'Plomberie', 'travaux', 2],
  ['electricite_travaux', 'Électricité (travaux)', 'travaux', 3],
  ['peinture', 'Peinture', 'travaux', 4],
  ['entretien', 'Entretien', 'entretien', 10],
  ['ascenseur', 'Ascenseur', 'entretien', 11],
  ['facture_eau', 'Facture eau', 'factures', 20],
  ['facture_electricite', 'Facture électricité', 'factures', 21],
  ['internet', 'Internet', 'factures', 22],
  ['nettoyage', 'Nettoyage', 'nettoyage', 30],
  ['securite', 'Sécurité', 'securite', 40],
  ['gardiennage', 'Gardiennage', 'securite', 41],
  ['taxes_impots', 'Taxes et impôts', 'autre', 50],
  ['assurance', 'Assurance', 'autre', 51],
  ['frais_gestion', 'Frais de gestion', 'autre', 52],
  ['autre', 'Autre dépense', 'autre', 99],
];

module.exports = {
  async up(queryInterface) {
    for (const [code, name, group, ordre] of CATEGORIES) {
      await queryInterface.sequelize.query(
        `INSERT INTO expense_categories (owner_id, code, name, cash_group, sort_order)
         VALUES (NULL, :code, :name, :group, :ordre)
         ON CONFLICT (code) WHERE owner_id IS NULL DO NOTHING`,
        { replacements: { code, name, group, ordre } }
      );
    }
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DELETE FROM expense_categories e WHERE owner_id IS NULL AND NOT EXISTS (SELECT 1 FROM expenses x WHERE x.category_id = e.id)');
  },
};
