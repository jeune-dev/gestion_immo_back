'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `roles` — schéma défini par les migrations (src/migrations). */
const Role = sequelize.define('Role', {
  code: { type: DataTypes.STRING(40), primaryKey: true },
  label: { type: DataTypes.STRING(100), allowNull: false },
  description: { type: DataTypes.TEXT },
  permissions: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
  is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName: 'roles',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Role;
