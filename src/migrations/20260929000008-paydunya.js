'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Agrégateur de paiement : PayTech → PayDunya (§ 31, § 51).
 *
 * Valeurs ÉCRITES EN DUR (et non lues dans config/enums.js) : une migration
 * doit produire le même schéma quel que soit l'état futur du code.
 *
 * Données existantes :
 *   - moyens de paiement « paytech » → « paydunya » DÉSACTIVÉS : leurs clés
 *     PayTech ne valent rien chez PayDunya ; le propriétaire saisit ses clés
 *     PayDunya pour réactiver (refusé tant qu'elles manquent, voir
 *     paiement.service.configurerMoyen) ;
 *   - transactions et paiements d'abonnement : le fournisseur est renommé.
 *     Aucune n'existe en production à la date de la migration (application
 *     jamais déployée) ; le changement de nom garde l'unicité
 *     (provider, provider_transaction_id).
 */

const FOURNISSEURS = "('paydunya', 'wave', 'orange_money')";
const FOURNISSEURS_AVANT = "('paytech', 'wave', 'orange_money')";

const remplacer = (depuis, vers, fournisseurs, abonnements) => [
  'ALTER TABLE payment_providers DROP CONSTRAINT IF EXISTS payment_providers_provider_check',
  'ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_provider_check',
  'ALTER TABLE subscription_payments DROP CONSTRAINT IF EXISTS subscription_payments_provider_check',
  `UPDATE payment_providers SET provider = '${vers}', is_active = false, updated_at = now() WHERE provider = '${depuis}'`,
  `UPDATE payment_transactions SET provider = '${vers}' WHERE provider = '${depuis}'`,
  `UPDATE subscription_payments SET provider = '${vers}' WHERE provider = '${depuis}'`,
  `ALTER TABLE payment_providers ADD CONSTRAINT payment_providers_provider_check CHECK (provider IN ${fournisseurs})`,
  `ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_provider_check CHECK (provider IN ${fournisseurs})`,
  `ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_provider_check CHECK (provider IN ${abonnements})`,
];

module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, remplacer('paytech', 'paydunya', FOURNISSEURS, "('paydunya', 'manuel')"));
  },
  async down(queryInterface) {
    await executer(queryInterface, remplacer('paydunya', 'paytech', FOURNISSEURS_AVANT, "('paytech', 'manuel')"));
  },
};
