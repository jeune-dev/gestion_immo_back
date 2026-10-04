'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `cash_movements` — schéma défini par les migrations (src/migrations). */
const CashMovement = sequelize.define('CashMovement', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  building_id: { type: DataTypes.UUID },
  apartment_id: { type: DataTypes.UUID },
  direction: { type: DataTypes.STRING(6), allowNull: false },
  category: { type: DataTypes.STRING(15), allowNull: false },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  method: { type: DataTypes.STRING(15), allowNull: false },
  occurred_on: { type: DataTypes.DATEONLY, allowNull: false },
  label: { type: DataTypes.STRING(200), allowNull: false },
  source_type: { type: DataTypes.STRING(25), allowNull: false },
  source_id: { type: DataTypes.UUID },
  is_deposit: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  cancelled_at: { type: DataTypes.DATE },
  created_by: { type: DataTypes.UUID },
}, {
  tableName: 'cash_movements',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = CashMovement;
