'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { encrypt, decrypt } = require('../utils/cryptoField.js');

/** Table `reconciliation_entries` — schéma défini par les migrations (src/migrations). */
const ReconciliationEntry = sequelize.define('ReconciliationEntry', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  type: { type: DataTypes.STRING(15), allowNull: false },
  status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'en_attente' },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  transaction_id: { type: DataTypes.UUID },
  rent_payment_id: { type: DataTypes.UUID },
  lease_id: { type: DataTypes.UUID },
  tenant_id: { type: DataTypes.UUID },
  // Numéro du payeur : chiffré au repos (constat M13), jamais critère de recherche.
  payer_phone: {
    type: DataTypes.TEXT,
    get() {
      const brut = this.getDataValue('payer_phone');
      return brut ? decrypt(brut) : brut;
    },
    set(valeur) {
      this.setDataValue('payer_phone', valeur ? encrypt(valeur) : null);
    },
  },
  details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  resolution_note: { type: DataTypes.TEXT },
  resolved_by: { type: DataTypes.UUID },
  resolved_at: { type: DataTypes.DATE },
}, {
  tableName: 'reconciliation_entries',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = ReconciliationEntry;
