'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `charge_invoices` — schéma défini par les migrations (src/migrations). */
const ChargeInvoice = sequelize.define('ChargeInvoice', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  building_id: { type: DataTypes.UUID, allowNull: false },
  charge_type: { type: DataTypes.STRING(15), allowNull: false },
  supplier: { type: DataTypes.STRING(120) },
  invoice_number: { type: DataTypes.STRING(60) },
  period_start: { type: DataTypes.DATEONLY, allowNull: false },
  period_end: { type: DataTypes.DATEONLY, allowNull: false },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  due_date: { type: DataTypes.DATEONLY },
  allocation_method: { type: DataTypes.STRING(15), allowNull: false },
  recharge_to_tenants: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'brouillon' },
  allocated_at: { type: DataTypes.DATE },
  notes: { type: DataTypes.TEXT },
  created_by: { type: DataTypes.UUID },
}, {
  tableName: 'charge_invoices',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = ChargeInvoice;
