'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `subscription_plans` — schéma défini par les migrations (src/migrations). */
const SubscriptionPlan = sequelize.define('SubscriptionPlan', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  code: { type: DataTypes.STRING(30), allowNull: false },
  name: { type: DataTypes.STRING(80), allowNull: false },
  description: { type: DataTypes.TEXT },
  price: { type: DataTypes.BIGINT, allowNull: false },
  currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'XOF' },
  billing_period: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'mensuel' },
  max_buildings: { type: DataTypes.INTEGER },
  max_apartments: { type: DataTypes.INTEGER },
  max_whatsapp_per_month: { type: DataTypes.INTEGER },
  features: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'actif' },
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, {
  tableName: 'subscription_plans',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = SubscriptionPlan;
