'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `message_threads` — schéma défini par les migrations (src/migrations). */
const MessageThread = sequelize.define('MessageThread', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  last_message_at: { type: DataTypes.DATE },
}, {
  tableName: 'message_threads',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = MessageThread;
