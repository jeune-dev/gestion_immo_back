'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `lease_templates` — schéma défini par les migrations (src/migrations). */
const LeaseTemplate = sequelize.define('LeaseTemplate', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  lease_type: { type: DataTypes.STRING(15), allowNull: false },
  version: { type: DataTypes.INTEGER, allowNull: false },
  title: { type: DataTypes.STRING(150), allowNull: false },
  body: { type: DataTypes.TEXT, allowNull: false },
  status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'brouillon' },
  legal_notes: { type: DataTypes.TEXT },
  published_at: { type: DataTypes.DATE },
  published_by: { type: DataTypes.UUID },
  created_by: { type: DataTypes.UUID },
}, {
  tableName: 'lease_templates',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = LeaseTemplate;
