'use strict';

const E = require('../config/enums.js');
const { dans, HORODATAGE, executer } = require('../database/migrationHelpers.js');

/**
 * Finances : échéances, charges et factures communes, paiements (espèces,
 * Wave / Orange Money, preuves), rapprochement, quittances, relances,
 * dépenses, caisse et cautions.
 * Cahier des charges § 11–17, 20, 21, 41, 51, 55.
 *
 * Invariants garantis PAR LA BASE (en plus des services) :
 *   - montants entiers positifs (FCFA) ;
 *   - une échéance ne peut pas être « plus que payée » ;
 *   - une allocation vise exactement une échéance OU une charge ;
 *   - une confirmation fournisseur n'est comptée qu'une fois (§ 51.3) ;
 *   - une retenue sur caution exige motif, description et justificatif (§ 55.4) ;
 *   - la caution restituée + retenue ne dépasse jamais le montant versé.
 */
module.exports = {
  async up(queryInterface) {
    const ENCOURS = "('a_venir', 'a_payer', 'partiellement_paye', 'en_retard')";

    await executer(queryInterface, [
      `CREATE TABLE rent_schedules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        lease_id uuid NOT NULL REFERENCES leases(id),
        apartment_id uuid NOT NULL REFERENCES apartments(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        period_start date NOT NULL,
        period_end date NOT NULL,
        due_date date NOT NULL,
        label varchar(80) NOT NULL,
        rent_amount bigint NOT NULL CHECK (rent_amount >= 0),
        charges_amount bigint NOT NULL DEFAULT 0 CHECK (charges_amount >= 0),
        amount_due bigint NOT NULL CHECK (amount_due > 0),
        amount_paid bigint NOT NULL DEFAULT 0,
        status varchar(20) NOT NULL ${dans('status', E.STATUT_ECHEANCE)},
        paid_at timestamptz,
        cancelled_at timestamptz,
        cancel_reason text,
        ${HORODATAGE},
        CONSTRAINT rent_schedules_montant_ck CHECK (amount_due = rent_amount + charges_amount),
        CONSTRAINT rent_schedules_paye_ck CHECK (amount_paid >= 0 AND amount_paid <= amount_due),
        CONSTRAINT rent_schedules_periode_ck CHECK (period_end >= period_start),
        CONSTRAINT rent_schedules_statut_paye_ck CHECK (status <> 'paye' OR amount_paid = amount_due),
        CONSTRAINT rent_schedules_periode_uq UNIQUE (lease_id, period_start)
      )`,
      'CREATE INDEX rent_schedules_owner_idx ON rent_schedules (owner_id, status, due_date)',
      'CREATE INDEX rent_schedules_tenant_idx ON rent_schedules (tenant_id, due_date)',
      'CREATE INDEX rent_schedules_lease_idx ON rent_schedules (lease_id, due_date)',
      `CREATE INDEX rent_schedules_encours_idx ON rent_schedules (due_date) WHERE status IN ${ENCOURS}`,

      `CREATE TABLE charge_invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        building_id uuid NOT NULL REFERENCES buildings(id),
        charge_type varchar(15) NOT NULL ${dans('charge_type', E.TYPE_CHARGE)},
        supplier varchar(120),
        invoice_number varchar(60),
        period_start date NOT NULL,
        period_end date NOT NULL,
        amount bigint NOT NULL CHECK (amount > 0),
        due_date date,
        allocation_method varchar(15) NOT NULL ${dans('allocation_method', E.METHODE_REPARTITION)},
        recharge_to_tenants boolean NOT NULL DEFAULT true,
        status varchar(10) NOT NULL DEFAULT 'brouillon' ${dans('status', E.STATUT_FACTURE_COMMUNE)},
        allocated_at timestamptz,
        notes text,
        created_by uuid REFERENCES users(id),
        ${HORODATAGE},
        CONSTRAINT charge_invoices_periode_ck CHECK (period_end >= period_start)
      )`,
      "CREATE UNIQUE INDEX charge_invoices_numero_uq ON charge_invoices (owner_id, lower(supplier), invoice_number) WHERE invoice_number IS NOT NULL AND status <> 'annulee'",
      'CREATE INDEX charge_invoices_owner_idx ON charge_invoices (owner_id, status, period_start DESC)',
      'CREATE INDEX charge_invoices_building_idx ON charge_invoices (building_id)',

      // Trace EXPLICABLE de la répartition (§ 17) : base, part et justification.
      `CREATE TABLE charge_allocations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        charge_invoice_id uuid NOT NULL REFERENCES charge_invoices(id),
        apartment_id uuid NOT NULL REFERENCES apartments(id),
        lease_id uuid REFERENCES leases(id),
        basis_value numeric(14,4),
        share numeric(12,8) NOT NULL CHECK (share >= 0 AND share <= 1),
        amount bigint NOT NULL CHECK (amount >= 0),
        explanation text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT charge_allocations_uq UNIQUE (charge_invoice_id, apartment_id)
      )`,
      'CREATE INDEX charge_allocations_apartment_idx ON charge_allocations (apartment_id)',

      // Part refacturée à un locataire.
      `CREATE TABLE charges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        lease_id uuid NOT NULL REFERENCES leases(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        apartment_id uuid NOT NULL REFERENCES apartments(id),
        charge_invoice_id uuid NOT NULL REFERENCES charge_invoices(id),
        charge_allocation_id uuid NOT NULL UNIQUE REFERENCES charge_allocations(id),
        charge_type varchar(15) NOT NULL ${dans('charge_type', E.TYPE_CHARGE)},
        label varchar(150) NOT NULL,
        amount bigint NOT NULL CHECK (amount > 0),
        amount_paid bigint NOT NULL DEFAULT 0,
        due_date date NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'a_payer' ${dans('status', E.STATUT_CHARGE)},
        paid_at timestamptz,
        cancelled_at timestamptz,
        ${HORODATAGE},
        CONSTRAINT charges_paye_ck CHECK (amount_paid >= 0 AND amount_paid <= amount),
        CONSTRAINT charges_statut_paye_ck CHECK (status <> 'paye' OR amount_paid = amount)
      )`,
      'CREATE INDEX charges_tenant_idx ON charges (tenant_id, status)',
      'CREATE INDEX charges_owner_idx ON charges (owner_id, status, due_date)',
      'CREATE INDEX charges_lease_idx ON charges (lease_id)',

      // Identifiants de paiement PAR PROPRIÉTAIRE (§ 51.5) : les fonds arrivent
      // sur son compte ; `credentials` est chiffré (AES-256-GCM) par l'application.
      `CREATE TABLE payment_providers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        provider varchar(15) NOT NULL ${dans('provider', E.FOURNISSEUR_PAIEMENT)},
        mode varchar(10) NOT NULL ${dans('mode', E.MODE_TRANSACTION)},
        label varchar(100),
        account_number varchar(30),
        credentials text,
        is_active boolean NOT NULL DEFAULT true,
        ${HORODATAGE},
        CONSTRAINT payment_providers_uq UNIQUE (owner_id, provider, mode),
        CONSTRAINT payment_providers_config_ck CHECK (
          (mode = 'integre' AND credentials IS NOT NULL) OR (mode = 'preuve' AND account_number IS NOT NULL)
        )
      )`,

      `CREATE TABLE payment_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        lease_id uuid NOT NULL REFERENCES leases(id),
        rent_schedule_id uuid REFERENCES rent_schedules(id),
        charge_id uuid REFERENCES charges(id),
        payment_provider_id uuid REFERENCES payment_providers(id),
        provider varchar(15) NOT NULL ${dans('provider', E.FOURNISSEUR_PAIEMENT)},
        wallet varchar(15) ${dans('wallet', E.PORTEFEUILLE)},
        mode varchar(10) NOT NULL ${dans('mode', E.MODE_TRANSACTION)},
        reference varchar(40) NOT NULL UNIQUE,
        provider_transaction_id varchar(128),
        provider_token varchar(255),
        payer_phone varchar(20),
        amount bigint NOT NULL CHECK (amount > 0),
        fees bigint NOT NULL DEFAULT 0 CHECK (fees >= 0),
        currency char(3) NOT NULL DEFAULT 'XOF',
        status varchar(15) NOT NULL DEFAULT 'initiee' ${dans('status', E.STATUT_TRANSACTION)},
        checkout_url text,
        proof_document_id uuid REFERENCES documents(id),
        validated_by uuid REFERENCES users(id),
        validated_at timestamptz,
        rejection_reason text,
        confirmed_at timestamptz,
        failed_at timestamptz,
        cancelled_at timestamptz,
        refunded_at timestamptz,
        expires_at timestamptz,
        raw_payload jsonb,
        initiated_by uuid NOT NULL REFERENCES users(id),
        ${HORODATAGE},
        CONSTRAINT payment_transactions_cible_ck CHECK (num_nonnulls(rent_schedule_id, charge_id) <= 1)
      )`,
      // § 51.3 : un même identifiant de transaction n'est compté qu'une fois.
      'CREATE UNIQUE INDEX payment_transactions_fournisseur_uq ON payment_transactions (provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL',
      'CREATE INDEX payment_transactions_owner_idx ON payment_transactions (owner_id, status, created_at DESC)',
      'CREATE INDEX payment_transactions_tenant_idx ON payment_transactions (tenant_id, created_at DESC)',
      'CREATE INDEX payment_transactions_schedule_idx ON payment_transactions (rent_schedule_id)',
      "CREATE INDEX payment_transactions_expiration_idx ON payment_transactions (expires_at) WHERE status IN ('initiee', 'en_attente')",

      `CREATE TABLE rent_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        lease_id uuid NOT NULL REFERENCES leases(id),
        apartment_id uuid NOT NULL REFERENCES apartments(id),
        transaction_id uuid UNIQUE REFERENCES payment_transactions(id),
        amount bigint NOT NULL CHECK (amount > 0),
        method varchar(15) NOT NULL ${dans('method', E.MODE_PAIEMENT)},
        paid_on date NOT NULL,
        reference varchar(40) NOT NULL,
        comment text,
        status varchar(10) NOT NULL DEFAULT 'valide' ${dans('status', E.STATUT_PAIEMENT)},
        refunded_at timestamptz,
        refund_reason text,
        refunded_by uuid REFERENCES users(id),
        recorded_by uuid NOT NULL REFERENCES users(id),
        ${HORODATAGE},
        CONSTRAINT rent_payments_reference_uq UNIQUE (owner_id, reference)
      )`,
      'CREATE INDEX rent_payments_owner_idx ON rent_payments (owner_id, paid_on DESC)',
      'CREATE INDEX rent_payments_lease_idx ON rent_payments (lease_id, paid_on DESC)',
      'CREATE INDEX rent_payments_tenant_idx ON rent_payments (tenant_id, paid_on DESC)',
      'CREATE INDEX rent_payments_apartment_idx ON rent_payments (apartment_id, paid_on DESC)',

      `CREATE TABLE payment_allocations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        rent_payment_id uuid NOT NULL REFERENCES rent_payments(id),
        rent_schedule_id uuid REFERENCES rent_schedules(id),
        charge_id uuid REFERENCES charges(id),
        amount bigint NOT NULL CHECK (amount > 0),
        reversed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payment_allocations_cible_ck CHECK (num_nonnulls(rent_schedule_id, charge_id) = 1)
      )`,
      'CREATE INDEX payment_allocations_payment_idx ON payment_allocations (rent_payment_id)',
      'CREATE INDEX payment_allocations_schedule_idx ON payment_allocations (rent_schedule_id) WHERE reversed_at IS NULL',
      'CREATE INDEX payment_allocations_charge_idx ON payment_allocations (charge_id) WHERE reversed_at IS NULL',

      // File « À rapprocher » et excédents en attente de décision (§ 51.3).
      `CREATE TABLE reconciliation_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        type varchar(15) NOT NULL ${dans('type', E.TYPE_RAPPROCHEMENT)},
        status varchar(12) NOT NULL DEFAULT 'en_attente' ${dans('status', E.STATUT_RAPPROCHEMENT)},
        amount bigint NOT NULL CHECK (amount > 0),
        transaction_id uuid REFERENCES payment_transactions(id),
        rent_payment_id uuid REFERENCES rent_payments(id),
        lease_id uuid REFERENCES leases(id),
        tenant_id uuid REFERENCES tenants(id),
        payer_phone varchar(20),
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        resolution_note text,
        resolved_by uuid REFERENCES users(id),
        resolved_at timestamptz,
        ${HORODATAGE}
      )`,
      'CREATE INDEX reconciliation_entries_owner_idx ON reconciliation_entries (owner_id, status, created_at DESC)',

      `CREATE TABLE receipts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        rent_schedule_id uuid NOT NULL REFERENCES rent_schedules(id),
        lease_id uuid NOT NULL REFERENCES leases(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        number varchar(30) NOT NULL,
        amount bigint NOT NULL CHECK (amount > 0),
        issued_at timestamptz NOT NULL DEFAULT now(),
        document_id uuid REFERENCES documents(id),
        payment_references text[] NOT NULL DEFAULT '{}',
        cancelled_at timestamptz,
        cancel_reason text,
        ${HORODATAGE},
        CONSTRAINT receipts_numero_uq UNIQUE (owner_id, number)
      )`,
      // Une quittance VALIDE par échéance ; un remboursement l'annule (§ 51.4).
      'CREATE UNIQUE INDEX receipts_schedule_uq ON receipts (rent_schedule_id) WHERE cancelled_at IS NULL',
      'CREATE INDEX receipts_tenant_idx ON receipts (tenant_id, issued_at DESC)',
      'CREATE INDEX receipts_owner_idx ON receipts (owner_id, issued_at DESC)',

      // Une relance par échéance et par délai (J-3, J0, J+3…), jamais deux.
      `CREATE TABLE rent_reminders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        rent_schedule_id uuid NOT NULL REFERENCES rent_schedules(id),
        offset_days smallint NOT NULL,
        channels text[] NOT NULL DEFAULT '{}',
        sent_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT rent_reminders_uq UNIQUE (rent_schedule_id, offset_days)
      )`,

      `CREATE TABLE expense_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid REFERENCES owners(id),
        code varchar(40) NOT NULL,
        name varchar(100) NOT NULL,
        cash_group varchar(15) NOT NULL ${dans('cash_group', E.GROUPE_CAISSE_SORTIE)},
        is_active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        ${HORODATAGE}
      )`,
      'CREATE UNIQUE INDEX expense_categories_globale_uq ON expense_categories (code) WHERE owner_id IS NULL',
      'CREATE UNIQUE INDEX expense_categories_owner_uq ON expense_categories (owner_id, code) WHERE owner_id IS NOT NULL',

      `CREATE TABLE expenses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        building_id uuid NOT NULL REFERENCES buildings(id),
        apartment_id uuid REFERENCES apartments(id),
        category_id uuid NOT NULL REFERENCES expense_categories(id),
        amount bigint NOT NULL CHECK (amount > 0),
        method varchar(15) NOT NULL ${dans('method', E.MODE_PAIEMENT)},
        spent_on date NOT NULL,
        description varchar(500),
        contractor_id uuid REFERENCES contractors(id),
        work_order_id uuid REFERENCES work_orders(id),
        charge_invoice_id uuid REFERENCES charge_invoices(id),
        client_reference varchar(64),
        status varchar(10) NOT NULL DEFAULT 'valide' ${dans('status', E.STATUT_DEPENSE)},
        cancelled_at timestamptz,
        cancel_reason text,
        cancelled_by uuid REFERENCES users(id),
        created_by uuid NOT NULL REFERENCES users(id),
        ${HORODATAGE}
      )`,
      'CREATE UNIQUE INDEX expenses_client_reference_uq ON expenses (owner_id, client_reference) WHERE client_reference IS NOT NULL',
      'CREATE INDEX expenses_owner_idx ON expenses (owner_id, spent_on DESC)',
      'CREATE INDEX expenses_building_idx ON expenses (building_id, spent_on DESC)',
      'CREATE INDEX expenses_apartment_idx ON expenses (apartment_id)',
      'CREATE INDEX expenses_work_order_idx ON expenses (work_order_id)',
      'CREATE INDEX expenses_category_idx ON expenses (category_id)',

      // Caisse (§ 21) : journal des entrées / sorties ; la caution y figure à
      // part (is_deposit) et n'entre jamais dans les revenus (§ 55.4).
      `CREATE TABLE cash_movements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        building_id uuid REFERENCES buildings(id),
        apartment_id uuid REFERENCES apartments(id),
        direction varchar(6) NOT NULL ${dans('direction', E.SENS_CAISSE)},
        category varchar(15) NOT NULL ${dans('category', E.CATEGORIE_CAISSE)},
        amount bigint NOT NULL CHECK (amount > 0),
        method varchar(15) NOT NULL ${dans('method', E.MODE_PAIEMENT)},
        occurred_on date NOT NULL,
        label varchar(200) NOT NULL,
        source_type varchar(25) NOT NULL CHECK (source_type IN ('rent_payment', 'expense', 'deposit_transaction', 'manuel')),
        source_id uuid,
        is_deposit boolean NOT NULL DEFAULT false,
        cancelled_at timestamptz,
        created_by uuid REFERENCES users(id),
        ${HORODATAGE},
        CONSTRAINT cash_movements_caution_ck CHECK (is_deposit = (category = 'caution'))
      )`,
      'CREATE INDEX cash_movements_owner_idx ON cash_movements (owner_id, occurred_on DESC) WHERE cancelled_at IS NULL',
      'CREATE INDEX cash_movements_source_idx ON cash_movements (source_type, source_id)',
      'CREATE INDEX cash_movements_building_idx ON cash_movements (building_id, occurred_on DESC)',

      `CREATE TABLE deposits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        lease_id uuid NOT NULL UNIQUE REFERENCES leases(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        amount_expected bigint NOT NULL CHECK (amount_expected >= 0),
        amount_received bigint NOT NULL DEFAULT 0 CHECK (amount_received >= 0),
        amount_withheld bigint NOT NULL DEFAULT 0 CHECK (amount_withheld >= 0),
        amount_refunded bigint NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
        status varchar(22) NOT NULL DEFAULT 'attendue' ${dans('status', E.STATUT_CAUTION)},
        refund_due_date date,
        settlement_started_at timestamptz,
        settled_at timestamptz,
        ${HORODATAGE},
        CONSTRAINT deposits_solde_ck CHECK (amount_withheld + amount_refunded <= amount_received)
      )`,
      'CREATE INDEX deposits_owner_idx ON deposits (owner_id, status)',
      'CREATE INDEX deposits_tenant_idx ON deposits (tenant_id)',

      `CREATE TABLE deposit_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        deposit_id uuid NOT NULL REFERENCES deposits(id),
        type varchar(12) NOT NULL ${dans('type', E.TYPE_MOUVEMENT_CAUTION)},
        amount bigint NOT NULL CHECK (amount > 0),
        occurred_on date NOT NULL,
        method varchar(15) ${dans('method', E.MODE_PAIEMENT)},
        reference varchar(64),
        reason varchar(15) ${dans('reason', E.MOTIF_RETENUE)},
        description text,
        justification_document_ids uuid[] NOT NULL DEFAULT '{}',
        inspection_item_ids uuid[] NOT NULL DEFAULT '{}',
        tenant_acknowledged_at timestamptz,
        receipt_document_id uuid REFERENCES documents(id),
        contest_status varchar(10) ${dans('contest_status', E.STATUT_CONTESTATION)},
        contest_message text,
        contested_at timestamptz,
        owner_response text,
        contest_outcome text,
        contest_resolved_at timestamptz,
        adjusted_amount bigint CHECK (adjusted_amount IS NULL OR adjusted_amount >= 0),
        created_by uuid REFERENCES users(id),
        ${HORODATAGE},
        CONSTRAINT deposit_transactions_retenue_ck CHECK (
          type <> 'retenue' OR (reason IS NOT NULL AND description IS NOT NULL AND cardinality(justification_document_ids) > 0)
        ),
        CONSTRAINT deposit_transactions_contestation_ck CHECK (contest_status IS NULL OR type = 'retenue')
      )`,
      'CREATE INDEX deposit_transactions_deposit_idx ON deposit_transactions (deposit_id, created_at)',
    ]);
  },

  async down(queryInterface) {
    await executer(queryInterface, [
      'DROP TABLE IF EXISTS deposit_transactions, deposits, cash_movements, expenses, expense_categories, rent_reminders, receipts, reconciliation_entries, payment_allocations, rent_payments, payment_transactions, payment_providers, charges, charge_allocations, charge_invoices, rent_schedules CASCADE',
    ]);
  },
};
