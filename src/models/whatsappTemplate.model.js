'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `whatsapp_templates` — schéma défini par les migrations (src/migrations). */
const WhatsappTemplate = sequelize.define('WhatsappTemplate', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  event_code: { type: DataTypes.STRING(50), allowNull: false },
  meta_template_name: { type: DataTypes.STRING(100), allowNull: false },
  language_code: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'fr' },
  body_preview: { type: DataTypes.TEXT, allowNull: false },
  variables: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName: 'whatsapp_templates',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = WhatsappTemplate;
