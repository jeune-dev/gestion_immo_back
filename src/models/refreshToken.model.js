'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `refresh_tokens` — schéma défini par les migrations (src/migrations). */
const RefreshToken = sequelize.define('RefreshToken', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  user_id: { type: DataTypes.UUID, allowNull: false },
  token_hash: { type: DataTypes.CHAR(64), allowNull: false },
  expires_at: { type: DataTypes.DATE, allowNull: false },
  revoked_at: { type: DataTypes.DATE },
  // rotation | deconnexion | plafond | distante | globale | rejeu | expiration
  revoked_reason: { type: DataTypes.STRING(20) },
  // Début de la SESSION (transmis de rotation en rotation) : durée maximale absolue.
  session_started_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  device_name: { type: DataTypes.STRING(120) },
  platform: { type: DataTypes.STRING(10) },
  ip: { type: DataTypes.STRING(64) },
  user_agent: { type: DataTypes.STRING(300) },
  last_used_at: { type: DataTypes.DATE },
}, {
  tableName: 'refresh_tokens',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = RefreshToken;
