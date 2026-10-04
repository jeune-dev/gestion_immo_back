'use strict';

/**
 * Index relevés par l'audit de performance sur la base AMPLIFIÉE
 * (docs/PERFORMANCE.md — 53 000 échéances pour un compte, 500 000 lignes de
 * journal d'audit), trois lectures coûtaient en proportion de TOUT l'historique
 * au lieu de la page demandée — coût qui grandit sans fin avec l'ancienneté.
 *
 *   - échéances d'un propriétaire, tri par défaut (due_date, id) : l'index
 *     existant (owner_id, status, due_date) ne sert que filtré par statut.
 *     165 ms → 1,5 ms la page ;
 *   - journal d'audit de la plateforme (super admin), tri global
 *     (created_at DESC, id DESC) : seuls des index par propriétaire,
 *     utilisateur ou action existaient. 204 ms → 0,4 ms la page ;
 *   - « autres revenus » de caisse (rapports financier et rentabilité, § 21,
 *     § 26) : catégorie RARE, mais faute d'index le rapport lisait tous les
 *     mouvements de caisse du compte pour n'en garder aucun (15 550 lignes
 *     écartées). Index partiel : coût proportionnel aux seuls autres revenus.
 *
 * CONCURRENTLY, hors transaction : en production ces tables sont les plus
 * grosses de la base, un CREATE INDEX classique y bloquerait les écritures
 * (encaissements, journal) pendant toute sa construction.
 */
const INDEX = [
  ['rent_schedules_owner_echeance_idx', 'rent_schedules (owner_id, due_date, id)'],
  ['audit_logs_date_idx', 'audit_logs (created_at DESC, id DESC)'],
  ['cash_movements_autres_revenus_idx', "cash_movements (owner_id, occurred_on) WHERE category = 'autre_revenu' AND cancelled_at IS NULL"],
];

module.exports = {
  async up(queryInterface) {
    for (const [nom, definition] of INDEX) {
      // Une construction CONCURRENTLY interrompue laisse un index INVALIDE : on repart de zéro.
      await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${nom}`);
      await queryInterface.sequelize.query(`CREATE INDEX CONCURRENTLY ${nom} ON ${definition}`);
    }
  },
  async down(queryInterface) {
    for (const [nom] of [...INDEX].reverse()) {
      await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${nom}`);
    }
  },
};
