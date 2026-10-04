'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `work_photos` — schéma défini par les migrations (src/migrations). */
const WorkPhoto = sequelize.define('WorkPhoto', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  work_order_id: { type: DataTypes.UUID, allowNull: false },
  document_id: { type: DataTypes.UUID, allowNull: false },
  phase: { type: DataTypes.STRING(10), allowNull: false },
  caption: { type: DataTypes.STRING(255) },
  captured_at: { type: DataTypes.DATE },
}, {
  tableName: 'work_photos',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = WorkPhoto;
