'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `payment_allocations` — schéma défini par les migrations (src/migrations). */
const PaymentAllocation = sequelize.define('PaymentAllocation', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  rent_payment_id: { type: DataTypes.UUID, allowNull: false },
  rent_schedule_id: { type: DataTypes.UUID },
  charge_id: { type: DataTypes.UUID },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  reversed_at: { type: DataTypes.DATE },
}, {
  tableName: 'payment_allocations',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = PaymentAllocation;
