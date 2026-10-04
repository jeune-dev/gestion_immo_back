'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `deposit_transactions` — schéma défini par les migrations (src/migrations). */
const DepositTransaction = sequelize.define('DepositTransaction', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  deposit_id: { type: DataTypes.UUID, allowNull: false },
  type: { type: DataTypes.STRING(12), allowNull: false },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  occurred_on: { type: DataTypes.DATEONLY, allowNull: false },
  method: { type: DataTypes.STRING(15) },
  reference: { type: DataTypes.STRING(64) },
  reason: { type: DataTypes.STRING(15) },
  description: { type: DataTypes.TEXT },
  justification_document_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
  inspection_item_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
  tenant_acknowledged_at: { type: DataTypes.DATE },
  receipt_document_id: { type: DataTypes.UUID },
  contest_status: { type: DataTypes.STRING(10) },
  contest_message: { type: DataTypes.TEXT },
  contested_at: { type: DataTypes.DATE },
  owner_response: { type: DataTypes.TEXT },
  contest_outcome: { type: DataTypes.TEXT },
  contest_resolved_at: { type: DataTypes.DATE },
  adjusted_amount: { type: DataTypes.BIGINT },
  created_by: { type: DataTypes.UUID },
}, {
  tableName: 'deposit_transactions',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = DepositTransaction;
