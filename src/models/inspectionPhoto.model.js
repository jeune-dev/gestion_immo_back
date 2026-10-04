'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `inspection_photos` — schéma défini par les migrations (src/migrations). */
const InspectionPhoto = sequelize.define('InspectionPhoto', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  inspection_id: { type: DataTypes.UUID, allowNull: false },
  item_id: { type: DataTypes.UUID, allowNull: false },
  document_id: { type: DataTypes.UUID, allowNull: false },
  captured_at: { type: DataTypes.DATE },
}, {
  tableName: 'inspection_photos',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = InspectionPhoto;
