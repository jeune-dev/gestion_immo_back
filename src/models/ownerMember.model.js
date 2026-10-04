'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `owner_members` — schéma défini par les migrations (src/migrations). */
const OwnerMember = sequelize.define('OwnerMember', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  user_id: { type: DataTypes.UUID, allowNull: false },
  role_code: { type: DataTypes.STRING(40), allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'actif' },
}, {
  tableName: 'owner_members',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = OwnerMember;
