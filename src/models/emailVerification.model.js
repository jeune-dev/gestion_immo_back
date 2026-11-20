'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * Table `email_verifications` — code envoyé à une adresse AVANT que le compte
 * n'existe (inscription en deux temps). Schéma défini par les migrations.
 */
const EmailVerification = sequelize.define('EmailVerification', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  email: { type: DataTypes.STRING(254), allowNull: false },
  code_hash: { type: DataTypes.CHAR(64), allowNull: false },
  expires_at: { type: DataTypes.DATE, allowNull: false },
  attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
  verified_at: { type: DataTypes.DATE },
  used_at: { type: DataTypes.DATE },
}, {
  tableName: 'email_verifications',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = EmailVerification;
