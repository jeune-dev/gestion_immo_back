'use strict';

/**
 * Plans tarifaires initiaux (§ 31). Les PRIX sont ceux donnés en exemple par
 * le cahier des charges ; ils sont modifiables depuis le Super Admin et ne
 * sont jamais codés en dur ailleurs. Les limites sont des valeurs de départ,
 * à ajuster par le Super Admin. `ON CONFLICT DO NOTHING` : relancer le seeder
 * n'écrase jamais un plan modifié en production.
 */
const TOUTES = ['paiement_integre', 'relances_whatsapp', 'rapports', 'modeles_bail', 'etats_des_lieux', 'messagerie'];

const PLANS = [
  { code: 'STARTER', name: 'Starter', price: 5000, max_buildings: 1, max_apartments: 10, max_whatsapp_per_month: 50, features: TOUTES, sort_order: 1 },
  { code: 'BUSINESS', name: 'Business', price: 15000, max_buildings: 5, max_apartments: 60, max_whatsapp_per_month: 300, features: TOUTES, sort_order: 2 },
  { code: 'PRO', name: 'Pro', price: 35000, max_buildings: null, max_apartments: null, max_whatsapp_per_month: 1500, features: TOUTES, sort_order: 3 },
];

module.exports = {
  async up(queryInterface) {
    for (const p of PLANS) {
      await queryInterface.sequelize.query(
        `INSERT INTO subscription_plans (code, name, price, currency, billing_period, max_buildings, max_apartments, max_whatsapp_per_month, features, status, sort_order)
         VALUES (:code, :name, :price, 'XOF', 'mensuel', :max_buildings, :max_apartments, :max_whatsapp_per_month, ARRAY[:features]::text[], 'actif', :sort_order)
         ON CONFLICT (code) DO NOTHING`,
        { replacements: p }
      );
    }
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query("DELETE FROM subscription_plans WHERE code IN ('STARTER', 'BUSINESS', 'PRO') AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.plan_id = subscription_plans.id)");
  },
};
