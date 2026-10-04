'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `charge_allocations` — schéma défini par les migrations (src/migrations). */
const ChargeAllocation = sequelize.define('ChargeAllocation', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  charge_invoice_id: { type: DataTypes.UUID, allowNull: false },
  apartment_id: { type: DataTypes.UUID, allowNull: false },
  lease_id: { type: DataTypes.UUID },
  basis_value: { type: DataTypes.DECIMAL(14, 4) },
  share: { type: DataTypes.DECIMAL(12, 8), allowNull: false },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  explanation: { type: DataTypes.TEXT, allowNull: false },
}, {
  tableName: 'charge_allocations',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = ChargeAllocation;
