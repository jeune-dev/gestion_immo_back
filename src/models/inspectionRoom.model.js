'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `inspection_rooms` — schéma défini par les migrations (src/migrations). */
const InspectionRoom = sequelize.define('InspectionRoom', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  inspection_id: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING(80), allowNull: false },
  position: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
  notes: { type: DataTypes.TEXT },
}, {
  tableName: 'inspection_rooms',
  timestamps: false,
});

module.exports = InspectionRoom;
