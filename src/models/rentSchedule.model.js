'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `rent_schedules` — schéma défini par les migrations (src/migrations). */
const RentSchedule = sequelize.define('RentSchedule', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  lease_id: { type: DataTypes.UUID, allowNull: false },
  apartment_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  period_start: { type: DataTypes.DATEONLY, allowNull: false },
  period_end: { type: DataTypes.DATEONLY, allowNull: false },
  due_date: { type: DataTypes.DATEONLY, allowNull: false },
  label: { type: DataTypes.STRING(80), allowNull: false },
  rent_amount: { type: DataTypes.BIGINT, allowNull: false },
  charges_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  amount_due: { type: DataTypes.BIGINT, allowNull: false },
  amount_paid: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.STRING(20), allowNull: false },
  paid_at: { type: DataTypes.DATE },
  cancelled_at: { type: DataTypes.DATE },
  cancel_reason: { type: DataTypes.TEXT },
}, {
  tableName: 'rent_schedules',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = RentSchedule;
