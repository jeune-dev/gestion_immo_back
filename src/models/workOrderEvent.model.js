'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `work_order_events` — schéma défini par les migrations (src/migrations). */
const WorkOrderEvent = sequelize.define('WorkOrderEvent', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  work_order_id: { type: DataTypes.UUID, allowNull: false },
  from_status: { type: DataTypes.STRING(20) },
  to_status: { type: DataTypes.STRING(20), allowNull: false },
  comment: { type: DataTypes.TEXT },
  user_id: { type: DataTypes.UUID },
}, {
  tableName: 'work_order_events',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = WorkOrderEvent;
