'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `owners` — schéma défini par les migrations (src/migrations). */
const Owner = sequelize.define('Owner', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  user_id: { type: DataTypes.UUID, allowNull: false },
  display_name: { type: DataTypes.STRING(150), allowNull: false },
  company_name: { type: DataTypes.STRING(150) },
  phone: { type: DataTypes.STRING(20) },
  email: { type: DataTypes.STRING(254) },
  address: { type: DataTypes.STRING(255) },
  city: { type: DataTypes.STRING(100) },
  country: { type: DataTypes.CHAR(2), allowNull: false, defaultValue: 'SN' },
  currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'XOF' },
  settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'actif' },
}, {
  tableName: 'owners',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  paranoid: true, deletedAt: 'deleted_at',
});

module.exports = Owner;
