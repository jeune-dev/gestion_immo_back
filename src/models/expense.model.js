'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `expenses` — schéma défini par les migrations (src/migrations). */
const Expense = sequelize.define('Expense', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  building_id: { type: DataTypes.UUID, allowNull: false },
  apartment_id: { type: DataTypes.UUID },
  category_id: { type: DataTypes.UUID, allowNull: false },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  method: { type: DataTypes.STRING(15), allowNull: false },
  spent_on: { type: DataTypes.DATEONLY, allowNull: false },
  description: { type: DataTypes.STRING(500) },
  contractor_id: { type: DataTypes.UUID },
  work_order_id: { type: DataTypes.UUID },
  charge_invoice_id: { type: DataTypes.UUID },
  client_reference: { type: DataTypes.STRING(64) },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'valide' },
  cancelled_at: { type: DataTypes.DATE },
  cancel_reason: { type: DataTypes.TEXT },
  cancelled_by: { type: DataTypes.UUID },
  created_by: { type: DataTypes.UUID, allowNull: false },
}, {
  tableName: 'expenses',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Expense;
