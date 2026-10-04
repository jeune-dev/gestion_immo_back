'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `password_resets` — schéma défini par les migrations (src/migrations). */
const PasswordReset = sequelize.define('PasswordReset', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  user_id: { type: DataTypes.UUID, allowNull: false },
  otp_hash: { type: DataTypes.CHAR(64), allowNull: false },
  expires_at: { type: DataTypes.DATE, allowNull: false },
  attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
  used_at: { type: DataTypes.DATE },
}, {
  tableName: 'password_resets',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = PasswordReset;
