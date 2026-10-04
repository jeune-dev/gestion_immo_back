'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `subscriptions` — schéma défini par les migrations (src/migrations). */
const Subscription = sequelize.define('Subscription', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  plan_id: { type: DataTypes.UUID, allowNull: false },
  status: { type: DataTypes.STRING(12), allowNull: false },
  started_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  current_period_start: { type: DataTypes.DATEONLY, allowNull: false },
  current_period_end: { type: DataTypes.DATEONLY, allowNull: false },
  trial_ends_at: { type: DataTypes.DATEONLY },
  cancelled_at: { type: DataTypes.DATE },
  suspended_reason: { type: DataTypes.TEXT },
}, {
  tableName: 'subscriptions',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Subscription;
