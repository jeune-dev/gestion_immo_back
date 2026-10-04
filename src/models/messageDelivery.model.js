'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `message_deliveries` — schéma défini par les migrations (src/migrations). */
const MessageDelivery = sequelize.define('MessageDelivery', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID },
  notification_id: { type: DataTypes.UUID },
  user_id: { type: DataTypes.UUID },
  tenant_id: { type: DataTypes.UUID },
  channel: { type: DataTypes.STRING(10), allowNull: false },
  event_code: { type: DataTypes.STRING(50) },
  template_name: { type: DataTypes.STRING(100) },
  destination: { type: DataTypes.STRING(254) },
  status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'en_attente' },
  provider_message_id: { type: DataTypes.STRING(128) },
  error: { type: DataTypes.TEXT },
  sent_at: { type: DataTypes.DATE },
  delivered_at: { type: DataTypes.DATE },
  read_at: { type: DataTypes.DATE },
  failed_at: { type: DataTypes.DATE },
}, {
  tableName: 'message_deliveries',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = MessageDelivery;
