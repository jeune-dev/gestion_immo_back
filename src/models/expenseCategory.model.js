'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `expense_categories` — schéma défini par les migrations (src/migrations). */
const ExpenseCategory = sequelize.define('ExpenseCategory', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID },
  code: { type: DataTypes.STRING(40), allowNull: false },
  name: { type: DataTypes.STRING(100), allowNull: false },
  cash_group: { type: DataTypes.STRING(15), allowNull: false },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, {
  tableName: 'expense_categories',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = ExpenseCategory;
