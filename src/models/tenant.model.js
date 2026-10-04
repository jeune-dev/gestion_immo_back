'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { encrypt, decrypt } = require('../utils/cryptoField.js');

/** Table `tenants` — schéma défini par les migrations (src/migrations). */
const Tenant = sequelize.define('Tenant', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  user_id: { type: DataTypes.UUID },
  first_name: { type: DataTypes.STRING(80), allowNull: false },
  last_name: { type: DataTypes.STRING(80), allowNull: false },
  phone: { type: DataTypes.STRING(20), allowNull: false },
  email: { type: DataTypes.STRING(254) },
  id_document_type: { type: DataTypes.STRING(20) },
  // Numéro de pièce d'identité : donnée personnelle sensible, chiffrée au repos
  // (AES-256-GCM, APP_ENC_KEY — § 32 « chiffrement des données sensibles »).
  id_document_number: {
    type: DataTypes.TEXT,
    get() {
      const brut = this.getDataValue('id_document_number');
      return brut ? decrypt(brut) : brut;
    },
    set(valeur) {
      this.setDataValue('id_document_number', valeur ? encrypt(valeur) : null);
    },
  },
  // Texte libre du bailleur : chiffré au repos (constat M13 de l’audit).
  notes: {
    type: DataTypes.TEXT,
    get() {
      const brut = this.getDataValue('notes');
      return brut ? decrypt(brut) : brut;
    },
    set(valeur) {
      this.setDataValue('notes', valeur ? encrypt(valeur) : null);
    },
  },
  whatsapp_consent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  whatsapp_consent_at: { type: DataTypes.DATE },
  whatsapp_consent_revoked_at: { type: DataTypes.DATE },
  created_by: { type: DataTypes.UUID },
}, {
  tableName: 'tenants',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  paranoid: true, deletedAt: 'deleted_at',
});

module.exports = Tenant;
