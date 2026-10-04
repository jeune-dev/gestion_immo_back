'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `audit_logs` — schéma défini par les migrations (src/migrations). */
const AuditLog = sequelize.define('AuditLog', {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  user_id: { type: DataTypes.UUID },
  owner_id: { type: DataTypes.UUID },
  actor_role: { type: DataTypes.STRING(40) },
  action: { type: DataTypes.STRING(80), allowNull: false },
  entity_type: { type: DataTypes.STRING(40) },
  entity_id: { type: DataTypes.STRING(64) },
  details: { type: DataTypes.JSONB },
  ip: { type: DataTypes.STRING(64) },
  user_agent: { type: DataTypes.STRING(300) },
  request_id: { type: DataTypes.STRING(128) },
}, {
  tableName: 'audit_logs',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = AuditLog;
