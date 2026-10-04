'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { encrypt, decrypt } = require('../utils/cryptoField.js');

/** Table `users` — schéma défini par les migrations (src/migrations). */
const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  role_code: { type: DataTypes.STRING(40), allowNull: false },
  first_name: { type: DataTypes.STRING(80), allowNull: false },
  last_name: { type: DataTypes.STRING(80), allowNull: false },
  email: { type: DataTypes.STRING(254) },
  phone: { type: DataTypes.STRING(20) },
  password_hash: { type: DataTypes.STRING(100), allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'actif' },
  email_verified_at: { type: DataTypes.DATE },
  failed_login_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  locked_until: { type: DataTypes.DATE },
  token_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  must_change_password: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  last_login_at: { type: DataTypes.DATE },
  language: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'fr' },
  // Double authentification TOTP : secret chiffré au repos (AES-256-GCM, APP_ENC_KEY).
  totp_secret: {
    type: DataTypes.TEXT,
    get() {
      const brut = this.getDataValue('totp_secret');
      return brut ? decrypt(brut) : brut;
    },
    set(valeur) {
      this.setDataValue('totp_secret', valeur ? encrypt(valeur) : null);
    },
  },
  totp_enabled_at: { type: DataTypes.DATE },
  totp_last_step: { type: DataTypes.BIGINT },
  mfa_recovery_codes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
}, {
  tableName: 'users',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  paranoid: true, deletedAt: 'deleted_at',
});

/**
 * Colonnes qui ne sortent JAMAIS d'une réponse (reprise de Widjila) : ce filet
 * s'applique à toute sérialisation JSON, même d'une instance brute.
 */
const COLONNES_SECRETES = [
  'password_hash', 'token_version', 'failed_login_attempts', 'locked_until', 'deleted_at',
  'totp_secret', 'totp_last_step', 'mfa_recovery_codes',
];

User.prototype.toJSON = function toJSON() {
  const valeurs = { ...this.get({ plain: true }) };
  for (const cle of COLONNES_SECRETES) delete valeurs[cle];
  return valeurs;
};

module.exports = User;
module.exports.COLONNES_SECRETES = COLONNES_SECRETES;
