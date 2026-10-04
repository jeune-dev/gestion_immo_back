'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `messages` — schéma défini par les migrations (src/migrations). */
const Message = sequelize.define('Message', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  thread_id: { type: DataTypes.UUID, allowNull: false },
  sender_user_id: { type: DataTypes.UUID, allowNull: false },
  sender_role: { type: DataTypes.STRING(20), allowNull: false },
  body: { type: DataTypes.TEXT },
  document_id: { type: DataTypes.UUID },
  related_type: { type: DataTypes.STRING(20) },
  related_id: { type: DataTypes.UUID },
  read_at: { type: DataTypes.DATE },
}, {
  tableName: 'messages',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = Message;
