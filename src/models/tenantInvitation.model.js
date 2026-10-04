'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `tenant_invitations` — schéma défini par les migrations (src/migrations). */
const TenantInvitation = sequelize.define('TenantInvitation', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  token_hash: { type: DataTypes.CHAR(64), allowNull: false },
  code_hash: { type: DataTypes.CHAR(64), allowNull: false },
  expires_at: { type: DataTypes.DATE, allowNull: false },
  used_at: { type: DataTypes.DATE },
  revoked_at: { type: DataTypes.DATE },
  attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
  created_by: { type: DataTypes.UUID },
}, {
  tableName: 'tenant_invitations',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = TenantInvitation;
