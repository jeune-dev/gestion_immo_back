'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `lease_documents` — schéma défini par les migrations (src/migrations). */
const LeaseDocument = sequelize.define('LeaseDocument', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  lease_id: { type: DataTypes.UUID, allowNull: false },
  template_id: { type: DataTypes.UUID, allowNull: false },
  template_version: { type: DataTypes.INTEGER, allowNull: false },
  version: { type: DataTypes.INTEGER, allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false },
  special_clauses: { type: DataTypes.TEXT },
  document_id: { type: DataTypes.UUID },
  generated_by: { type: DataTypes.UUID },
  shared_at: { type: DataTypes.DATE },
}, {
  tableName: 'lease_documents',
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = LeaseDocument;
