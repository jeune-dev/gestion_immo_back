'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `buildings` — schéma défini par les migrations (src/migrations). */
const Building = sequelize.define('Building', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  name: { type: DataTypes.STRING(150), allowNull: false },
  address: { type: DataTypes.STRING(255), allowNull: false },
  district: { type: DataTypes.STRING(100) },
  city: { type: DataTypes.STRING(100), allowNull: false },
  floors_count: { type: DataTypes.SMALLINT },
  declared_apartments_count: { type: DataTypes.INTEGER },
  description: { type: DataTypes.TEXT },
}, {
  tableName: 'buildings',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  paranoid: true, deletedAt: 'deleted_at',
});

module.exports = Building;
