'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `idempotency_keys` — schéma défini par les migrations (src/migrations). */
const IdempotencyKey = sequelize.define('IdempotencyKey', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  user_id: { type: DataTypes.UUID, allowNull: false },
  key: { type: DataTypes.STRING(128), allowNull: false },
  method: { type: DataTypes.STRING(8), allowNull: false },
  path: { type: DataTypes.STRING(300), allowNull: false },
  request_hash: { type: DataTypes.CHAR(64), allowNull: false },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'en_cours' },
  response_status: { type: DataTypes.INTEGER },
  response_body: { type: DataTypes.JSONB },
  expires_at: { type: DataTypes.DATE, allowNull: false },
}, {
  tableName: 'idempotency_keys',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = IdempotencyKey;
