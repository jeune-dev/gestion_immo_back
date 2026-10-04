'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `work_orders` — schéma défini par les migrations (src/migrations). */
const WorkOrder = sequelize.define('WorkOrder', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  number: { type: DataTypes.INTEGER, allowNull: false },
  building_id: { type: DataTypes.UUID, allowNull: false },
  apartment_id: { type: DataTypes.UUID },
  incident_id: { type: DataTypes.UUID },
  contractor_id: { type: DataTypes.UUID },
  title: { type: DataTypes.STRING(150), allowNull: false },
  description: { type: DataTypes.TEXT },
  category: { type: DataTypes.STRING(20), allowNull: false },
  priority: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'normale' },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'signale' },
  estimated_amount: { type: DataTypes.BIGINT },
  actual_amount: { type: DataTypes.BIGINT },
  scheduled_for: { type: DataTypes.DATEONLY },
  started_at: { type: DataTypes.DATE },
  completed_at: { type: DataTypes.DATE },
  cancelled_at: { type: DataTypes.DATE },
  cancel_reason: { type: DataTypes.TEXT },
  created_by: { type: DataTypes.UUID },
}, {
  tableName: 'work_orders',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = WorkOrder;
