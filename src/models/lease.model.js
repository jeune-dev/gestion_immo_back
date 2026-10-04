'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `leases` — schéma défini par les migrations (src/migrations). */
const Lease = sequelize.define('Lease', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  apartment_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  reference: { type: DataTypes.STRING(30), allowNull: false },
  lease_type: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'habitation' },
  start_date: { type: DataTypes.DATEONLY, allowNull: false },
  end_date: { type: DataTypes.DATEONLY },
  rent_amount: { type: DataTypes.BIGINT, allowNull: false },
  charges_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  deposit_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  periodicity: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'mensuel' },
  due_day: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 5 },
  occupants_count: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
  special_conditions: { type: DataTypes.TEXT },
  rent_revision_rule: { type: DataTypes.TEXT },
  notice_period_months: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'brouillon' },
  activated_at: { type: DataTypes.DATE },
  ended_on: { type: DataTypes.DATEONLY },
  termination_reason: { type: DataTypes.TEXT },
  closed_at: { type: DataTypes.DATE },
  cancelled_at: { type: DataTypes.DATE },
  created_by: { type: DataTypes.UUID },
}, {
  tableName: 'leases',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Lease;
