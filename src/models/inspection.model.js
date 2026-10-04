'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `inspections` — schéma défini par les migrations (src/migrations). */
const Inspection = sequelize.define('Inspection', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  lease_id: { type: DataTypes.UUID, allowNull: false },
  apartment_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  type: { type: DataTypes.STRING(10), allowNull: false },
  version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  previous_version_id: { type: DataTypes.UUID },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'brouillon' },
  performed_at: { type: DataTypes.DATE },
  parties_present: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  water_meter: { type: DataTypes.DECIMAL(12, 3) },
  electricity_meter: { type: DataTypes.DECIMAL(12, 3) },
  keys_count: { type: DataTypes.SMALLINT },
  keys_details: { type: DataTypes.TEXT },
  general_observations: { type: DataTypes.TEXT },
  submitted_at: { type: DataTypes.DATE },
  response_deadline: { type: DataTypes.DATE },
  accepted_at: { type: DataTypes.DATE },
  accepted_tacitly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  contested_at: { type: DataTypes.DATE },
  contest_comment: { type: DataTypes.TEXT },
  locked_at: { type: DataTypes.DATE },
  document_id: { type: DataTypes.UUID },
  created_by: { type: DataTypes.UUID },
  client_reference: { type: DataTypes.STRING(64) },
}, {
  tableName: 'inspections',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Inspection;
