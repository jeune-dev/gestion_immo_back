'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `incidents` — schéma défini par les migrations (src/migrations). */
const Incident = sequelize.define('Incident', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  tenant_id: { type: DataTypes.UUID },
  lease_id: { type: DataTypes.UUID },
  building_id: { type: DataTypes.UUID, allowNull: false },
  apartment_id: { type: DataTypes.UUID },
  reference: { type: DataTypes.STRING(30), allowNull: false },
  category: { type: DataTypes.STRING(20), allowNull: false },
  title: { type: DataTypes.STRING(150), allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'signale' },
  owner_note: { type: DataTypes.TEXT },
  rejection_reason: { type: DataTypes.TEXT },
  reported_by: { type: DataTypes.UUID, allowNull: false },
  analysed_at: { type: DataTypes.DATE },
  resolved_at: { type: DataTypes.DATE },
  rejected_at: { type: DataTypes.DATE },
  client_reference: { type: DataTypes.STRING(64) },
}, {
  tableName: 'incidents',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Incident;
