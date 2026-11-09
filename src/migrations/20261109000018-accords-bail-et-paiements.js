'use strict';

const { executer, dans, HORODATAGE } = require('../database/migrationHelpers.js');
const E = require('../config/enums.js');

const TYPES_AVANT = Object.keys(E.TYPE_NOTIFICATION).filter((t) => t !== 'bail');

/**
 * Consentements du locataire (analyse de cohérence du projet) :
 *
 *   - bail : proposition au locataire, acceptation (application ou papier
 *     signé) ou refus AVANT l'activation ; congé donné par l'une des parties
 *     et date de sortie prévue ; alertes de fin de bail déjà envoyées ;
 *   - `lease_amendments` : un changement de loyer est un AVENANT proposé au
 *     locataire, appliqué seulement après son accord ;
 *   - paiements : contestation d'un remboursement par le locataire ;
 *     déclaration d'un paiement en espèces (portefeuille « especes ») ;
 *     rappel au propriétaire d'une preuve en attente.
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      // ── Bail : accord du locataire et congé ──────────────────────────────
      'ALTER TABLE leases ADD COLUMN proposed_at timestamptz',
      'ALTER TABLE leases ADD COLUMN tenant_accepted_at timestamptz',
      'ALTER TABLE leases ADD COLUMN tenant_accepted_by uuid REFERENCES users(id)',
      'ALTER TABLE leases ADD COLUMN tenant_refused_at timestamptz',
      'ALTER TABLE leases ADD COLUMN refusal_reason text',
      "ALTER TABLE leases ADD COLUMN acceptance_method varchar(12) CHECK (acceptance_method IN ('application', 'papier'))",
      'ALTER TABLE leases ADD COLUMN acceptance_document_id uuid REFERENCES documents(id)',
      'ALTER TABLE leases ADD COLUMN notice_given_at timestamptz',
      "ALTER TABLE leases ADD COLUMN notice_given_by varchar(12) CHECK (notice_given_by IN ('proprietaire', 'locataire'))",
      'ALTER TABLE leases ADD COLUMN notice_reason text',
      'ALTER TABLE leases ADD COLUMN planned_exit_date date',
      "ALTER TABLE leases ADD COLUMN end_alerts_sent jsonb NOT NULL DEFAULT '[]'::jsonb",

      // ── Avenants de loyer ────────────────────────────────────────────────
      `CREATE TABLE lease_amendments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        lease_id uuid NOT NULL REFERENCES leases(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        previous_rent_amount bigint NOT NULL,
        previous_charges_amount bigint NOT NULL,
        rent_amount bigint NOT NULL CHECK (rent_amount > 0),
        charges_amount bigint NOT NULL CHECK (charges_amount >= 0),
        effective_from date NOT NULL,
        reason text,
        status varchar(10) NOT NULL DEFAULT 'propose' CHECK (status IN ('propose', 'accepte', 'refuse', 'annule')),
        acceptance_method varchar(12) CHECK (acceptance_method IN ('application', 'papier')),
        acceptance_document_id uuid REFERENCES documents(id),
        refusal_reason text,
        responded_at timestamptz,
        responded_by uuid REFERENCES users(id),
        applied_schedules integer,
        proposed_by uuid REFERENCES users(id),
        ${HORODATAGE}
      )`,
      'CREATE INDEX lease_amendments_lease_idx ON lease_amendments (lease_id, created_at DESC)',
      // Un seul avenant en attente par bail.
      "CREATE UNIQUE INDEX lease_amendments_en_attente_uq ON lease_amendments (lease_id) WHERE status = 'propose'",

      // Notifications « bail » (proposition, avenant, congé, fin de bail).
      'ALTER TABLE notifications DROP CONSTRAINT notifications_type_check',
      `ALTER TABLE notifications ADD CONSTRAINT notifications_type_check ${dans('type', E.TYPE_NOTIFICATION)}`,

      // ── Paiements ────────────────────────────────────────────────────────
      "ALTER TABLE rent_payments ADD COLUMN dispute_status varchar(10) CHECK (dispute_status IN ('conteste', 'resolu'))",
      'ALTER TABLE rent_payments ADD COLUMN dispute_message text',
      'ALTER TABLE rent_payments ADD COLUMN disputed_at timestamptz',
      'ALTER TABLE rent_payments ADD COLUMN dispute_response text',
      'ALTER TABLE rent_payments ADD COLUMN dispute_resolved_at timestamptz',
      'ALTER TABLE payment_transactions ADD COLUMN owner_reminded_at timestamptz',
      'ALTER TABLE payment_transactions ADD COLUMN declared_paid_on date',
      'ALTER TABLE payment_transactions DROP CONSTRAINT payment_transactions_wallet_check',
      `ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_wallet_check ${dans('wallet', E.PORTEFEUILLE_TRANSACTION)}`,
      'ALTER TABLE payment_transactions DROP CONSTRAINT payment_transactions_provider_check',
      `ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_provider_check ${dans('provider', E.FOURNISSEUR_TRANSACTION)}`,
    ]);
  },

  async down(queryInterface) {
    await executer(queryInterface, [
      "DELETE FROM payment_transactions WHERE wallet = 'especes'",
      'ALTER TABLE payment_transactions DROP CONSTRAINT payment_transactions_provider_check',
      "ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_provider_check CHECK (provider IN ('paydunya', 'wave', 'orange_money'))",
      'ALTER TABLE payment_transactions DROP CONSTRAINT payment_transactions_wallet_check',
      "ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_wallet_check CHECK (wallet IN ('wave', 'orange_money'))",
      'ALTER TABLE payment_transactions DROP COLUMN declared_paid_on',
      'ALTER TABLE payment_transactions DROP COLUMN owner_reminded_at',
      'ALTER TABLE rent_payments DROP COLUMN dispute_resolved_at',
      'ALTER TABLE rent_payments DROP COLUMN dispute_response',
      'ALTER TABLE rent_payments DROP COLUMN disputed_at',
      'ALTER TABLE rent_payments DROP COLUMN dispute_message',
      'ALTER TABLE rent_payments DROP COLUMN dispute_status',
      "UPDATE notifications SET type = 'systeme' WHERE type = 'bail'",
      'ALTER TABLE notifications DROP CONSTRAINT notifications_type_check',
      `ALTER TABLE notifications ADD CONSTRAINT notifications_type_check ${dans('type', TYPES_AVANT)}`,
      'DROP TABLE lease_amendments',
      'ALTER TABLE leases DROP COLUMN end_alerts_sent',
      'ALTER TABLE leases DROP COLUMN planned_exit_date',
      'ALTER TABLE leases DROP COLUMN notice_reason',
      'ALTER TABLE leases DROP COLUMN notice_given_by',
      'ALTER TABLE leases DROP COLUMN notice_given_at',
      'ALTER TABLE leases DROP COLUMN acceptance_document_id',
      'ALTER TABLE leases DROP COLUMN acceptance_method',
      'ALTER TABLE leases DROP COLUMN refusal_reason',
      'ALTER TABLE leases DROP COLUMN tenant_refused_at',
      'ALTER TABLE leases DROP COLUMN tenant_accepted_by',
      'ALTER TABLE leases DROP COLUMN tenant_accepted_at',
      'ALTER TABLE leases DROP COLUMN proposed_at',
    ]);
  },
};
