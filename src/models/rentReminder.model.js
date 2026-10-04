'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `rent_reminders` — schéma défini par les migrations (src/migrations). */
const RentReminder = sequelize.define('RentReminder', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  rent_schedule_id: { type: DataTypes.UUID, allowNull: false },
  offset_days: { type: DataTypes.SMALLINT, allowNull: false },
  channels: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
  sent_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
  tableName: 'rent_reminders',
  timestamps: false,
});

module.exports = RentReminder;
