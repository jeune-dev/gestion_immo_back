'use strict';

const E = require('../config/enums.js');
const { dans, HORODATAGE, executer } = require('../database/migrationHelpers.js');

/**
 * Socle : rôles, utilisateurs, espaces propriétaires, abonnements, sessions,
 * notifications, documents, journal d'audit et tables techniques.
 * Cahier des charges § 5, § 27, § 29–32, § 39 (domaine « Utilisateurs » et
 * « Transverse »), § 40.
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      // pgcrypto : gen_random_uuid() est natif depuis PostgreSQL 13 ; pg_trgm
      // accélère la recherche par nom (ILIKE '%…%') sur les grosses listes.
      'CREATE EXTENSION IF NOT EXISTS pg_trgm',

      `CREATE TABLE roles (
        code varchar(40) PRIMARY KEY,
        label varchar(100) NOT NULL,
        description text,
        permissions text[] NOT NULL DEFAULT '{}',
        is_system boolean NOT NULL DEFAULT false,
        ${HORODATAGE}
      )`,

      `CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        role_code varchar(40) NOT NULL REFERENCES roles(code) ON UPDATE CASCADE,
        first_name varchar(80) NOT NULL,
        last_name varchar(80) NOT NULL,
        email varchar(254),
        phone varchar(20),
        password_hash varchar(100) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'actif' ${dans('status', E.STATUT_UTILISATEUR)},
        email_verified_at timestamptz,
        failed_login_attempts integer NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
        locked_until timestamptz,
        token_version integer NOT NULL DEFAULT 0,
        must_change_password boolean NOT NULL DEFAULT false,
        last_login_at timestamptz,
        language varchar(5) NOT NULL DEFAULT 'fr',
        ${HORODATAGE},
        deleted_at timestamptz,
        CONSTRAINT users_identifiant_ck CHECK (email IS NOT NULL OR phone IS NOT NULL)
      )`,
      'CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE deleted_at IS NULL AND email IS NOT NULL',
      'CREATE UNIQUE INDEX users_phone_uq ON users (phone) WHERE deleted_at IS NULL AND phone IS NOT NULL',
      'CREATE INDEX users_role_status_idx ON users (role_code, status) WHERE deleted_at IS NULL',

      `CREATE TABLE owners (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id),
        display_name varchar(150) NOT NULL,
        company_name varchar(150),
        phone varchar(20),
        email varchar(254),
        address varchar(255),
        city varchar(100),
        country char(2) NOT NULL DEFAULT 'SN',
        currency char(3) NOT NULL DEFAULT 'XOF',
        settings jsonb NOT NULL DEFAULT '{}'::jsonb,
        status varchar(20) NOT NULL DEFAULT 'actif' ${dans('status', E.STATUT_PROPRIETAIRE)},
        ${HORODATAGE},
        deleted_at timestamptz
      )`,
      'CREATE UNIQUE INDEX owners_user_uq ON owners (user_id) WHERE deleted_at IS NULL',

      // Appartenance d'un compte à un espace propriétaire (§ 49 : Gestionnaire,
      // Agence, multi-propriétaires en V2 = un rôle de plus, pas une refonte).
      `CREATE TABLE owner_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id),
        role_code varchar(40) NOT NULL REFERENCES roles(code) ON UPDATE CASCADE,
        status varchar(20) NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'inactif')),
        ${HORODATAGE},
        CONSTRAINT owner_members_uq UNIQUE (owner_id, user_id)
      )`,
      'CREATE INDEX owner_members_user_idx ON owner_members (user_id) WHERE status = \'actif\'',

      `CREATE TABLE subscription_plans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(30) NOT NULL UNIQUE,
        name varchar(80) NOT NULL,
        description text,
        price bigint NOT NULL CHECK (price >= 0),
        currency char(3) NOT NULL DEFAULT 'XOF',
        billing_period varchar(10) NOT NULL DEFAULT 'mensuel' ${dans('billing_period', E.PERIODE_FACTURATION)},
        max_buildings integer CHECK (max_buildings IS NULL OR max_buildings > 0),
        max_apartments integer CHECK (max_apartments IS NULL OR max_apartments > 0),
        max_whatsapp_per_month integer CHECK (max_whatsapp_per_month IS NULL OR max_whatsapp_per_month >= 0),
        features text[] NOT NULL DEFAULT '{}',
        status varchar(10) NOT NULL DEFAULT 'actif' ${dans('status', E.STATUT_PLAN)},
        sort_order integer NOT NULL DEFAULT 0,
        ${HORODATAGE}
      )`,

      `CREATE TABLE subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        plan_id uuid NOT NULL REFERENCES subscription_plans(id),
        status varchar(12) NOT NULL ${dans('status', E.STATUT_ABONNEMENT)},
        started_at timestamptz NOT NULL DEFAULT now(),
        current_period_start date NOT NULL,
        current_period_end date NOT NULL,
        trial_ends_at date,
        cancelled_at timestamptz,
        suspended_reason text,
        ${HORODATAGE},
        CONSTRAINT subscriptions_periode_ck CHECK (current_period_end >= current_period_start)
      )`,
      // Un seul abonnement « courant » par propriétaire.
      "CREATE UNIQUE INDEX subscriptions_courant_uq ON subscriptions (owner_id) WHERE status IN ('essai', 'actif', 'suspendu')",
      'CREATE INDEX subscriptions_fin_idx ON subscriptions (status, current_period_end)',

      `CREATE TABLE subscription_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        subscription_id uuid REFERENCES subscriptions(id),
        plan_id uuid NOT NULL REFERENCES subscription_plans(id),
        amount bigint NOT NULL CHECK (amount >= 0),
        currency char(3) NOT NULL DEFAULT 'XOF',
        months smallint NOT NULL DEFAULT 1 CHECK (months BETWEEN 1 AND 24),
        provider varchar(20) NOT NULL CHECK (provider IN ('paytech', 'manuel')),
        reference varchar(64) NOT NULL UNIQUE,
        provider_transaction_id varchar(128),
        status varchar(10) NOT NULL DEFAULT 'initie' ${dans('status', E.STATUT_PAIEMENT_ABONNEMENT)},
        checkout_url text,
        paid_at timestamptz,
        recorded_by uuid REFERENCES users(id),
        note text,
        raw_payload jsonb,
        ${HORODATAGE}
      )`,
      'CREATE UNIQUE INDEX subscription_payments_fournisseur_uq ON subscription_payments (provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL',
      'CREATE INDEX subscription_payments_owner_idx ON subscription_payments (owner_id, created_at DESC)',

      `CREATE TABLE refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        device_name varchar(120),
        platform varchar(10),
        ip varchar(64),
        user_agent varchar(300),
        last_used_at timestamptz,
        ${HORODATAGE}
      )`,
      'CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id, expires_at)',

      `CREATE TABLE password_resets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        otp_hash char(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        attempts smallint NOT NULL DEFAULT 0,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC)',

      `CREATE TABLE device_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token varchar(512) NOT NULL UNIQUE,
        platform varchar(10) NOT NULL ${dans('platform', E.PLATEFORME_APPAREIL)},
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        ${HORODATAGE}
      )`,
      'CREATE INDEX device_tokens_user_idx ON device_tokens (user_id)',

      `CREATE TABLE platform_settings (
        key varchar(80) PRIMARY KEY,
        value jsonb NOT NULL,
        description text,
        updated_by uuid,
        ${HORODATAGE}
      )`,

      // Idempotence des requêtes mutantes (double clic, renvoi après coupure
      // réseau, synchronisation différée — § 34, § 44).
      `CREATE TABLE idempotency_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key varchar(128) NOT NULL,
        method varchar(8) NOT NULL,
        path varchar(300) NOT NULL,
        request_hash char(64) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'en_cours' CHECK (status IN ('en_cours', 'termine')),
        response_status integer,
        response_body jsonb,
        expires_at timestamptz NOT NULL,
        ${HORODATAGE},
        CONSTRAINT idempotency_keys_uq UNIQUE (user_id, key)
      )`,
      'CREATE INDEX idempotency_keys_expiration_idx ON idempotency_keys (expires_at)',

      // Numérotation lisible et sans trou par espace (travaux #00482, quittances…).
      `CREATE TABLE counters (
        scope varchar(160) PRIMARY KEY,
        value bigint NOT NULL DEFAULT 0
      )`,

      // Journal d'audit (§ 40) : jamais de clé étrangère, pour survivre à toute
      // évolution des lignes qu'il décrit.
      `CREATE TABLE audit_logs (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id uuid,
        owner_id uuid,
        actor_role varchar(40),
        action varchar(80) NOT NULL,
        entity_type varchar(40),
        entity_id varchar(64),
        details jsonb,
        ip varchar(64),
        user_agent varchar(300),
        request_id varchar(128),
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX audit_logs_owner_idx ON audit_logs (owner_id, created_at DESC)',
      'CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id)',
      'CREATE INDEX audit_logs_user_idx ON audit_logs (user_id, created_at DESC)',
      'CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC)',

      `CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        owner_id uuid REFERENCES owners(id),
        type varchar(30) NOT NULL ${dans('type', E.TYPE_NOTIFICATION)},
        title varchar(150) NOT NULL,
        body text NOT NULL,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC)',
      'CREATE INDEX notifications_non_lues_idx ON notifications (user_id) WHERE read_at IS NULL',

      `CREATE TABLE whatsapp_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_code varchar(50) NOT NULL UNIQUE,
        meta_template_name varchar(100) NOT NULL,
        language_code varchar(10) NOT NULL DEFAULT 'fr',
        body_preview text NOT NULL,
        variables text[] NOT NULL DEFAULT '{}',
        is_active boolean NOT NULL DEFAULT false,
        ${HORODATAGE}
      )`,

      // Stockage objet (§ 38) : seule la RÉFÉRENCE est en base.
      `CREATE TABLE documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid REFERENCES owners(id),
        tenant_id uuid,
        entity_type varchar(30) NOT NULL ${dans('entity_type', E.ENTITE_DOCUMENT)},
        entity_id uuid NOT NULL,
        category varchar(20) NOT NULL ${dans('category', E.CATEGORIE_DOCUMENT)},
        storage_key varchar(300) NOT NULL,
        thumbnail_key varchar(300),
        mime_type varchar(100) NOT NULL,
        size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
        original_name varchar(255),
        checksum char(64),
        visible_to_tenant boolean NOT NULL DEFAULT false,
        captured_at timestamptz,
        uploaded_by uuid REFERENCES users(id),
        ${HORODATAGE},
        deleted_at timestamptz
      )`,
      'CREATE INDEX documents_entity_idx ON documents (entity_type, entity_id) WHERE deleted_at IS NULL',
      'CREATE INDEX documents_owner_idx ON documents (owner_id, created_at DESC) WHERE deleted_at IS NULL',
      'CREATE INDEX documents_tenant_idx ON documents (tenant_id) WHERE visible_to_tenant AND deleted_at IS NULL',

      `CREATE TABLE message_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid REFERENCES owners(id),
        notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        tenant_id uuid,
        channel varchar(10) NOT NULL ${dans('channel', E.CANAL)},
        event_code varchar(50),
        template_name varchar(100),
        destination varchar(254),
        status varchar(12) NOT NULL DEFAULT 'en_attente' ${dans('status', E.STATUT_ENVOI)},
        provider_message_id varchar(128),
        error text,
        sent_at timestamptz,
        delivered_at timestamptz,
        read_at timestamptz,
        failed_at timestamptz,
        ${HORODATAGE}
      )`,
      'CREATE INDEX message_deliveries_fournisseur_idx ON message_deliveries (provider_message_id) WHERE provider_message_id IS NOT NULL',
      'CREATE INDEX message_deliveries_quota_idx ON message_deliveries (owner_id, channel, created_at)',
      'CREATE INDEX message_deliveries_tenant_idx ON message_deliveries (tenant_id, created_at DESC)',
    ]);
  },

  async down(queryInterface) {
    await executer(queryInterface, [
      'DROP TABLE IF EXISTS message_deliveries, documents, whatsapp_templates, notifications, audit_logs, counters, idempotency_keys, platform_settings, device_tokens, password_resets, refresh_tokens, subscription_payments, subscriptions, subscription_plans, owner_members, owners, users, roles CASCADE',
    ]);
  },
};
