'use strict';

const E = require('../config/enums.js');
const { dans, HORODATAGE, executer } = require('../database/migrationHelpers.js');

/**
 * Opérations : artisans, incidents, travaux (+ historique et photos),
 * messagerie, états des lieux.
 * Cahier des charges § 18, 19, 22, 23, 24, 52, 54.1.
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      `CREATE TABLE contractors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        name varchar(150) NOT NULL,
        phone varchar(20),
        trade varchar(20) NOT NULL ${dans('trade', E.METIER_ARTISAN)},
        email varchar(254),
        notes text,
        is_active boolean NOT NULL DEFAULT true,
        ${HORODATAGE},
        deleted_at timestamptz
      )`,
      'CREATE INDEX contractors_owner_idx ON contractors (owner_id, trade) WHERE deleted_at IS NULL',

      `CREATE TABLE incidents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        tenant_id uuid REFERENCES tenants(id),
        lease_id uuid REFERENCES leases(id),
        building_id uuid NOT NULL REFERENCES buildings(id),
        apartment_id uuid REFERENCES apartments(id),
        reference varchar(30) NOT NULL,
        category varchar(20) NOT NULL ${dans('category', E.CATEGORIE_INCIDENT)},
        title varchar(150) NOT NULL,
        description text NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'signale' ${dans('status', E.STATUT_INCIDENT)},
        owner_note text,
        rejection_reason text,
        reported_by uuid NOT NULL REFERENCES users(id),
        analysed_at timestamptz,
        resolved_at timestamptz,
        rejected_at timestamptz,
        client_reference varchar(64),
        ${HORODATAGE},
        CONSTRAINT incidents_reference_uq UNIQUE (owner_id, reference)
      )`,
      'CREATE INDEX incidents_owner_idx ON incidents (owner_id, status, created_at DESC)',
      'CREATE INDEX incidents_tenant_idx ON incidents (tenant_id, created_at DESC)',
      'CREATE INDEX incidents_apartment_idx ON incidents (apartment_id)',

      `CREATE TABLE work_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        number integer NOT NULL CHECK (number > 0),
        building_id uuid NOT NULL REFERENCES buildings(id),
        apartment_id uuid REFERENCES apartments(id),
        incident_id uuid REFERENCES incidents(id),
        contractor_id uuid REFERENCES contractors(id),
        title varchar(150) NOT NULL,
        description text,
        category varchar(20) NOT NULL ${dans('category', E.CATEGORIE_TRAVAUX)},
        priority varchar(10) NOT NULL DEFAULT 'normale' ${dans('priority', E.PRIORITE)},
        status varchar(20) NOT NULL DEFAULT 'signale' ${dans('status', E.STATUT_TRAVAUX)},
        estimated_amount bigint CHECK (estimated_amount IS NULL OR estimated_amount >= 0),
        actual_amount bigint CHECK (actual_amount IS NULL OR actual_amount >= 0),
        scheduled_for date,
        started_at timestamptz,
        completed_at timestamptz,
        cancelled_at timestamptz,
        cancel_reason text,
        created_by uuid REFERENCES users(id),
        ${HORODATAGE},
        CONSTRAINT work_orders_numero_uq UNIQUE (owner_id, number),
        CONSTRAINT work_orders_artisan_ck CHECK (status <> 'artisan_assigne' OR contractor_id IS NOT NULL)
      )`,
      'CREATE INDEX work_orders_owner_idx ON work_orders (owner_id, status, created_at DESC)',
      'CREATE INDEX work_orders_apartment_idx ON work_orders (apartment_id)',
      'CREATE INDEX work_orders_building_idx ON work_orders (building_id)',
      'CREATE INDEX work_orders_contractor_idx ON work_orders (contractor_id)',
      'CREATE INDEX work_orders_incident_idx ON work_orders (incident_id)',

      `CREATE TABLE work_order_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        work_order_id uuid NOT NULL REFERENCES work_orders(id),
        from_status varchar(20),
        to_status varchar(20) NOT NULL,
        comment text,
        user_id uuid REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX work_order_events_wo_idx ON work_order_events (work_order_id, created_at)',

      `CREATE TABLE work_photos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        work_order_id uuid NOT NULL REFERENCES work_orders(id),
        document_id uuid NOT NULL UNIQUE REFERENCES documents(id),
        phase varchar(10) NOT NULL ${dans('phase', E.PHASE_PHOTO)},
        caption varchar(255),
        captured_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX work_photos_wo_idx ON work_photos (work_order_id, phase, created_at)',

      // Messagerie (§ 54.1) : un fil par locataire, visible des deux parties seulement.
      `CREATE TABLE message_threads (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        last_message_at timestamptz,
        ${HORODATAGE},
        CONSTRAINT message_threads_uq UNIQUE (owner_id, tenant_id)
      )`,
      'CREATE INDEX message_threads_owner_idx ON message_threads (owner_id, last_message_at DESC NULLS LAST)',

      `CREATE TABLE messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        thread_id uuid NOT NULL REFERENCES message_threads(id),
        sender_user_id uuid NOT NULL REFERENCES users(id),
        sender_role varchar(20) NOT NULL CHECK (sender_role IN ('proprietaire', 'locataire')),
        body text,
        document_id uuid REFERENCES documents(id),
        related_type varchar(20) CHECK (related_type IN ('incident', 'rent_schedule', 'work_order')),
        related_id uuid,
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT messages_contenu_ck CHECK (body IS NOT NULL OR document_id IS NOT NULL),
        CONSTRAINT messages_rattachement_ck CHECK ((related_type IS NULL) = (related_id IS NULL))
      )`,
      'CREATE INDEX messages_thread_idx ON messages (thread_id, created_at DESC)',
      'CREATE INDEX messages_non_lus_idx ON messages (thread_id, sender_role) WHERE read_at IS NULL',

      // États des lieux (§ 52).
      `CREATE TABLE inspections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id uuid NOT NULL REFERENCES owners(id),
        lease_id uuid NOT NULL REFERENCES leases(id),
        apartment_id uuid NOT NULL REFERENCES apartments(id),
        tenant_id uuid NOT NULL REFERENCES tenants(id),
        type varchar(10) NOT NULL ${dans('type', E.TYPE_ETAT_DES_LIEUX)},
        version integer NOT NULL DEFAULT 1 CHECK (version > 0),
        previous_version_id uuid REFERENCES inspections(id),
        status varchar(10) NOT NULL DEFAULT 'brouillon' ${dans('status', E.STATUT_ETAT_DES_LIEUX)},
        performed_at timestamptz,
        parties_present jsonb NOT NULL DEFAULT '[]'::jsonb,
        water_meter numeric(12,3),
        electricity_meter numeric(12,3),
        keys_count smallint CHECK (keys_count IS NULL OR keys_count >= 0),
        keys_details text,
        general_observations text,
        submitted_at timestamptz,
        response_deadline timestamptz,
        accepted_at timestamptz,
        accepted_tacitly boolean NOT NULL DEFAULT false,
        contested_at timestamptz,
        contest_comment text,
        locked_at timestamptz,
        document_id uuid REFERENCES documents(id),
        created_by uuid REFERENCES users(id),
        ${HORODATAGE}
      )`,
      // Une seule version « vivante » par bail et par type.
      "CREATE UNIQUE INDEX inspections_version_vivante_uq ON inspections (lease_id, type) WHERE status <> 'remplace'",
      'CREATE INDEX inspections_owner_idx ON inspections (owner_id, status)',
      'CREATE INDEX inspections_tenant_idx ON inspections (tenant_id)',
      "CREATE INDEX inspections_echeance_idx ON inspections (response_deadline) WHERE status = 'soumis'",

      `CREATE TABLE inspection_rooms (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
        name varchar(80) NOT NULL,
        position smallint NOT NULL DEFAULT 0,
        notes text
      )`,
      'CREATE INDEX inspection_rooms_idx ON inspection_rooms (inspection_id, position)',

      `CREATE TABLE inspection_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
        room_id uuid NOT NULL REFERENCES inspection_rooms(id) ON DELETE CASCADE,
        element varchar(15) NOT NULL ${dans('element', E.ELEMENT_ETAT_DES_LIEUX)},
        label varchar(120),
        condition varchar(15) NOT NULL DEFAULT 'bon' ${dans('condition', E.ETAT_ELEMENT)},
        comment text,
        position smallint NOT NULL DEFAULT 0
      )`,
      'CREATE INDEX inspection_items_room_idx ON inspection_items (room_id, position)',
      'CREATE INDEX inspection_items_inspection_idx ON inspection_items (inspection_id)',

      `CREATE TABLE inspection_photos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
        item_id uuid NOT NULL REFERENCES inspection_items(id) ON DELETE CASCADE,
        document_id uuid NOT NULL UNIQUE REFERENCES documents(id),
        captured_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX inspection_photos_item_idx ON inspection_photos (item_id)',
    ]);
  },

  async down(queryInterface) {
    await executer(queryInterface, [
      'DROP TABLE IF EXISTS inspection_photos, inspection_items, inspection_rooms, inspections, messages, message_threads, work_photos, work_order_events, work_orders, incidents, contractors CASCADE',
    ]);
  },
};
