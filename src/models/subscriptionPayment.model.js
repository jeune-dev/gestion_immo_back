'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `subscription_payments` — schéma défini par les migrations (src/migrations). */
const SubscriptionPayment = sequelize.define('SubscriptionPayment', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  subscription_id: { type: DataTypes.UUID },
  plan_id: { type: DataTypes.UUID, allowNull: false },
  amount: { type: DataTypes.BIGINT, allowNull: false },
  currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'XOF' },
  months: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
  provider: { type: DataTypes.STRING(20), allowNull: false },
  reference: { type: DataTypes.STRING(64), allowNull: false },
  provider_transaction_id: { type: DataTypes.STRING(128) },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'initie' },
  checkout_url: { type: DataTypes.TEXT },
  paid_at: { type: DataTypes.DATE },
  recorded_by: { type: DataTypes.UUID },
  note: { type: DataTypes.TEXT },
  raw_payload: { type: DataTypes.JSONB },
}, {
  tableName: 'subscription_payments',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = SubscriptionPayment;
