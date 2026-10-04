'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `charges` — schéma défini par les migrations (src/migrations). */
const Charge = sequelize.define('Charge', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  lease_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  apartment_id: { type: DataTypes.UUID, allowNull: false },
  charge_invoice_id: { type: DataTypes.UUID, allowNull: false },
  charge_allocation_id: { type: DataTypes.UUID, allowNull: false },
  charge_type: { type: DataTypes.STRING(15), allowNull: false },
  label: { type: DataTypes.STRING(150), allowNull: false },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  amount_paid: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  due_date: { type: DataTypes.DATEONLY, allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'a_payer' },
  paid_at: { type: DataTypes.DATE },
  cancelled_at: { type: DataTypes.DATE },
}, {
  tableName: 'charges',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Charge;
