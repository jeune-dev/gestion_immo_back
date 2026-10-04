'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `device_tokens` — schéma défini par les migrations (src/migrations). */
const DeviceToken = sequelize.define('DeviceToken', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  user_id: { type: DataTypes.UUID, allowNull: false },
  token: { type: DataTypes.STRING(512), allowNull: false },
  platform: { type: DataTypes.STRING(10), allowNull: false },
  last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
  tableName: 'device_tokens',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = DeviceToken;
