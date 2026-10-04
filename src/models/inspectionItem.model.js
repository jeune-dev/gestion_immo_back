'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `inspection_items` — schéma défini par les migrations (src/migrations). */
const InspectionItem = sequelize.define('InspectionItem', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  inspection_id: { type: DataTypes.UUID, allowNull: false },
  room_id: { type: DataTypes.UUID, allowNull: false },
  element: { type: DataTypes.STRING(15), allowNull: false },
  label: { type: DataTypes.STRING(120) },
  condition: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'bon' },
  comment: { type: DataTypes.TEXT },
  position: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
}, {
  tableName: 'inspection_items',
  timestamps: false,
});

module.exports = InspectionItem;
