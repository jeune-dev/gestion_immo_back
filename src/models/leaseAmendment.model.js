'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `lease_amendments` — avenant de loyer proposé au locataire. */
const LeaseAmendment = sequelize.define('LeaseAmendment', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  lease_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  previous_rent_amount: { type: DataTypes.BIGINT, allowNull: false },
  previous_charges_amount: { type: DataTypes.BIGINT, allowNull: false },
  rent_amount: { type: DataTypes.BIGINT, allowNull: false },
  charges_amount: { type: DataTypes.BIGINT, allowNull: false },
  effective_from: { type: DataTypes.DATEONLY, allowNull: false },
  reason: { type: DataTypes.TEXT },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'propose' },
  acceptance_method: { type: DataTypes.STRING(12) },
  acceptance_document_id: { type: DataTypes.UUID },
  refusal_reason: { type: DataTypes.TEXT },
  responded_at: { type: DataTypes.DATE },
  responded_by: { type: DataTypes.UUID },
  applied_schedules: { type: DataTypes.INTEGER },
  proposed_by: { type: DataTypes.UUID },
}, {
  tableName: 'lease_amendments',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = LeaseAmendment;
