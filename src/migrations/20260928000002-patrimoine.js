'use strict';

const E = require('../config/enums.js');
const { dans, HORODATAGE, executer } = require('../database/migrationHelpers.js');

/**
 * Patrimoine : immeubles, appartements, locataires, invitations, modèles de
 * bail, baux et documents de bail.
 * Cahier des charges § 7, 8, 9, 10, 53 ; § 5 (invitation locataire).
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      `CREATE TABLE buildings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        name varchar(150) NOT NULL,
        address varchar(255) NOT NULL,
        district varchar(100),
        city varchar(100) NOT NULL,
        floors_count smallint CHECK (floors_count IS NULL OR floors_count >= 0),
        declared_apartments_count integer CHECK (declared_apartments_count IS NULL OR declared_apartments_count >= 0),
        description text,
        ${HORODATAGE},
        deleted_at timestamptz
      )`,
      'CREATE UNIQUE INDEX buildings_nom_uq ON buildings (owner_id, lower(name)) WHERE deleted_at IS NULL',
      'CREATE INDEX buildings_owner_idx ON buildings (owner_id, created_at DESC) WHERE deleted_at IS NULL',
      'CREATE INDEX buildings_nom_trgm_idx ON buildings USING gin (name gin_trgm_ops)',

      `CREATE TABLE apartments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        building_id uuid NOT NULL REFERENCES buildings(id),
        number varchar(30) NOT NULL,
        floor smallint,
        type varchar(20) NOT NULL ${dans('type', E.TYPE_APPARTEMENT)},
        surface numeric(8,2) CHECK (surface IS NULL OR surface > 0),
        rooms_count smallint CHECK (rooms_count IS NULL OR rooms_count >= 0),
        rent_amount bigint NOT NULL CHECK (rent_amount >= 0),
        charges_amount bigint NOT NULL DEFAULT 0 CHECK (charges_amount >= 0),
        charge_coefficient numeric(10,4) NOT NULL DEFAULT 1 CHECK (charge_coefficient > 0),
        is_furnished boolean NOT NULL DEFAULT false,
        status varchar(15) NOT NULL DEFAULT 'disponible' ${dans('status', E.STATUT_APPARTEMENT)},
        description text,
        ${HORODATAGE},
        deleted_at timestamptz
      )`,
      'CREATE UNIQUE INDEX apartments_numero_uq ON apartments (building_id, lower(number)) WHERE deleted_at IS NULL',
      'CREATE INDEX apartments_owner_statut_idx ON apartments (owner_id, status) WHERE deleted_at IS NULL',
      'CREATE INDEX apartments_building_idx ON apartments (building_id) WHERE deleted_at IS NULL',

      `CREATE TABLE tenants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        user_id uuid REFERENCES users(id),
        first_name varchar(80) NOT NULL,
        last_name varchar(80) NOT NULL,
        phone varchar(20) NOT NULL,
        email varchar(254),
        id_document_type varchar(20) ${dans('id_document_type', E.TYPE_PIECE_IDENTITE)},
        id_document_number text,
        notes text,
        whatsapp_consent boolean NOT NULL DEFAULT false,
        whatsapp_consent_at timestamptz,
        whatsapp_consent_revoked_at timestamptz,
        created_by uuid REFERENCES users(id),
        ${HORODATAGE},
        deleted_at timestamptz
      )`,
      'CREATE UNIQUE INDEX tenants_telephone_uq ON tenants (owner_id, phone) WHERE deleted_at IS NULL',
      'CREATE INDEX tenants_owner_idx ON tenants (owner_id, last_name, first_name) WHERE deleted_at IS NULL',
      'CREATE INDEX tenants_user_idx ON tenants (user_id) WHERE user_id IS NOT NULL',
      "CREATE INDEX tenants_nom_trgm_idx ON tenants USING gin ((first_name || ' ' || last_name) gin_trgm_ops)",
      'ALTER TABLE documents ADD CONSTRAINT documents_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
      'ALTER TABLE message_deliveries ADD CONSTRAINT message_deliveries_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id)',

      // Invitation d'un locataire (§ 5, options A et B) : lien ET code à usage
      // unique, stockés sous forme d'empreinte seulement.
      `CREATE TABLE tenant_invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        token_hash char(64) NOT NULL UNIQUE,
        code_hash char(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        revoked_at timestamptz,
        attempts smallint NOT NULL DEFAULT 0,
        created_by uuid REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX tenant_invitations_tenant_idx ON tenant_invitations (tenant_id, created_at DESC)',

      // Modèles de bail VERSIONNÉS (§ 53.4) : une ligne = une version.
      `CREATE TABLE lease_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        lease_type varchar(15) NOT NULL ${dans('lease_type', E.TYPE_BAIL)},
        version integer NOT NULL CHECK (version > 0),
        title varchar(150) NOT NULL,
        body text NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'brouillon' ${dans('status', E.STATUT_MODELE_BAIL)},
        legal_notes text,
        published_at timestamptz,
        published_by uuid REFERENCES users(id),
        created_by uuid REFERENCES users(id),
        ${HORODATAGE},
        CONSTRAINT lease_templates_version_uq UNIQUE (lease_type, version)
      )`,
      // Une seule version publiée à la fois par type de bail.
      "CREATE UNIQUE INDEX lease_templates_publie_uq ON lease_templates (lease_type) WHERE status = 'publie'",

      `CREATE TABLE leases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        apartment_id uuid NOT NULL REFERENCES apartments(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        reference varchar(30) NOT NULL,
        lease_type varchar(15) NOT NULL DEFAULT 'habitation' ${dans('lease_type', E.TYPE_BAIL)},
        start_date date NOT NULL,
        end_date date,
        rent_amount bigint NOT NULL CHECK (rent_amount > 0),
        charges_amount bigint NOT NULL DEFAULT 0 CHECK (charges_amount >= 0),
        deposit_amount bigint NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
        periodicity varchar(12) NOT NULL DEFAULT 'mensuel' ${dans('periodicity', E.PERIODICITE)},
        due_day smallint NOT NULL DEFAULT 5 CHECK (due_day BETWEEN 1 AND 28),
        occupants_count smallint NOT NULL DEFAULT 1 CHECK (occupants_count >= 1),
        special_conditions text,
        rent_revision_rule text,
        notice_period_months smallint NOT NULL DEFAULT 1 CHECK (notice_period_months BETWEEN 0 AND 24),
        status varchar(10) NOT NULL DEFAULT 'brouillon' ${dans('status', E.STATUT_BAIL)},
        activated_at timestamptz,
        ended_on date,
        termination_reason text,
        closed_at timestamptz,
        cancelled_at timestamptz,
        created_by uuid REFERENCES users(id),
        ${HORODATAGE},
        CONSTRAINT leases_dates_ck CHECK (end_date IS NULL OR end_date > start_date),
        CONSTRAINT leases_reference_uq UNIQUE (owner_id, reference)
      )`,
      // § 41 « un appartement occupé doit avoir un locataire actif » — et un seul.
      "CREATE UNIQUE INDEX leases_un_actif_par_appartement_uq ON leases (apartment_id) WHERE status = 'actif'",
      'CREATE INDEX leases_owner_statut_idx ON leases (owner_id, status)',
      'CREATE INDEX leases_tenant_idx ON leases (tenant_id)',
      'CREATE INDEX leases_apartment_idx ON leases (apartment_id, start_date DESC)',

      `CREATE TABLE lease_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        lease_id uuid NOT NULL REFERENCES leases(id),
        template_id uuid NOT NULL REFERENCES lease_templates(id),
        template_version integer NOT NULL,
        version integer NOT NULL CHECK (version > 0),
        content text NOT NULL,
        special_clauses text,
        document_id uuid REFERENCES documents(id),
        generated_by uuid REFERENCES users(id),
        shared_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT lease_documents_version_uq UNIQUE (lease_id, version)
      )`,
    ]);
  },

  async down(queryInterface) {
    await executer(queryInterface, [
      'ALTER TABLE message_deliveries DROP CONSTRAINT IF EXISTS message_deliveries_tenant_fk',
      'ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_tenant_fk',
      'DROP TABLE IF EXISTS lease_documents, leases, lease_templates, tenant_invitations, tenants, apartments, buildings CASCADE',
    ]);
  },
};
