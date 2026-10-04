'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `notifications` — schéma défini par les migrations (src/migrations). */
const Notification = sequelize.define('Notification', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  user_id: { type: DataTypes.UUID, allowNull: false },
  owner_id: { type: DataTypes.UUID },
  type: { type: DataTypes.STRING(30), allowNull: false },
  title: { type: DataTypes.STRING(150), allowNull: false },
  body: { type: DataTypes.TEXT, allowNull: false },
  data: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  read_at: { type: DataTypes.DATE },
}, {
  tableName: 'notifications',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = Notification;
