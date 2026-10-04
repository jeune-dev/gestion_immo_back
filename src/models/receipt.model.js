'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `receipts` — schéma défini par les migrations (src/migrations). */
const Receipt = sequelize.define('Receipt', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  rent_schedule_id: { type: DataTypes.UUID, allowNull: false },
  lease_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  number: { type: DataTypes.STRING(30), allowNull: false },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  issued_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  document_id: { type: DataTypes.UUID },
  payment_references: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
  cancelled_at: { type: DataTypes.DATE },
  cancel_reason: { type: DataTypes.TEXT },
}, {
  tableName: 'receipts',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Receipt;
