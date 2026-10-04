'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `platform_settings` — schéma défini par les migrations (src/migrations). */
const PlatformSetting = sequelize.define('PlatformSetting', {
  key: { type: DataTypes.STRING(80), primaryKey: true },
  value: { type: DataTypes.JSONB, allowNull: false },
  description: { type: DataTypes.TEXT },
  updated_by: { type: DataTypes.UUID },
}, {
  tableName: 'platform_settings',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = PlatformSetting;
