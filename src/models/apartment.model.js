'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `apartments` — schéma défini par les migrations (src/migrations). */
const Apartment = sequelize.define('Apartment', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  building_id: { type: DataTypes.UUID, allowNull: false },
  number: { type: DataTypes.STRING(30), allowNull: false },
  floor: { type: DataTypes.SMALLINT },
  type: { type: DataTypes.STRING(20), allowNull: false },
  surface: { type: DataTypes.DECIMAL(8, 2) },
  rooms_count: { type: DataTypes.SMALLINT },
  rent_amount: { type: DataTypes.BIGINT, allowNull: false },
  charges_amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
  charge_coefficient: { type: DataTypes.DECIMAL(10, 4), allowNull: false, defaultValue: 1 },
  is_furnished: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'disponible' },
  description: { type: DataTypes.TEXT },
}, {
  tableName: 'apartments',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  paranoid: true, deletedAt: 'deleted_at',
});

module.exports = Apartment;
