'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `deposits` — schéma défini par les migrations (src/migrations). */
const Deposit = sequelize.define('Deposit', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  lease_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  amount_expected: { type: DataTypes.BIGINT, allowNull: false },
  amount_received: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  amount_withheld: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  amount_refunded: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.STRING(22), allowNull: false, defaultValue: 'attendue' },
  refund_due_date: { type: DataTypes.DATEONLY },
  settlement_started_at: { type: DataTypes.DATE },
  settled_at: { type: DataTypes.DATE },
}, {
  tableName: 'deposits',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Deposit;
