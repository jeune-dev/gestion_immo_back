'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { encrypt, decrypt } = require('../utils/cryptoField.js');

/** Table `payment_transactions` — schéma défini par les migrations (src/migrations). */
const PaymentTransaction = sequelize.define('PaymentTransaction', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  lease_id: { type: DataTypes.UUID, allowNull: false },
  rent_schedule_id: { type: DataTypes.UUID },
  charge_id: { type: DataTypes.UUID },
  payment_provider_id: { type: DataTypes.UUID },
  provider: { type: DataTypes.STRING(15), allowNull: false },
  wallet: { type: DataTypes.STRING(15) },
  mode: { type: DataTypes.STRING(10), allowNull: false },
  reference: { type: DataTypes.STRING(40), allowNull: false },
  provider_transaction_id: { type: DataTypes.STRING(128) },
  provider_token: { type: DataTypes.STRING(255) },
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
  amount: { type: DataTypes.BIGINT, allowNull: false },
  fees: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'XOF' },
  status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'initiee' },
  checkout_url: { type: DataTypes.TEXT },
  proof_document_id: { type: DataTypes.UUID },
  validated_by: { type: DataTypes.UUID },
  validated_at: { type: DataTypes.DATE },
  rejection_reason: { type: DataTypes.TEXT },
  confirmed_at: { type: DataTypes.DATE },
  failed_at: { type: DataTypes.DATE },
  cancelled_at: { type: DataTypes.DATE },
  refunded_at: { type: DataTypes.DATE },
  expires_at: { type: DataTypes.DATE },
  raw_payload: { type: DataTypes.JSONB },
  initiated_by: { type: DataTypes.UUID, allowNull: false },
}, {
  tableName: 'payment_transactions',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = PaymentTransaction;
