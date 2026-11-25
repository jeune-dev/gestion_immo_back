'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `phone_verifications` — codes de vérification du téléphone envoyés par WhatsApp. */
const PhoneVerification = sequelize.define('PhoneVerification', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  phone: { type: DataTypes.STRING(20), allowNull: false },
  purpose: { type: DataTypes.STRING(30), allowNull: false },
  code_hash: { type: DataTypes.CHAR(64), allowNull: false },
  expires_at: { type: DataTypes.DATE, allowNull: false },
  attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
  used_at: { type: DataTypes.DATE },
}, {
  tableName: 'phone_verifications',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = PhoneVerification;
