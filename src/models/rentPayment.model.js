'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `rent_payments` — schéma défini par les migrations (src/migrations). */
const RentPayment = sequelize.define('RentPayment', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  lease_id: { type: DataTypes.UUID, allowNull: false },
  apartment_id: { type: DataTypes.UUID, allowNull: false },
  transaction_id: { type: DataTypes.UUID },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  method: { type: DataTypes.STRING(15), allowNull: false },
  paid_on: { type: DataTypes.DATEONLY, allowNull: false },
  reference: { type: DataTypes.STRING(40), allowNull: false },
  comment: { type: DataTypes.TEXT },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'valide' },
  refunded_at: { type: DataTypes.DATE },
  refund_reason: { type: DataTypes.TEXT },
  refunded_by: { type: DataTypes.UUID },
  recorded_by: { type: DataTypes.UUID, allowNull: false },
}, {
  tableName: 'rent_payments',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = RentPayment;
