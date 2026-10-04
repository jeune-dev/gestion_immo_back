'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/** Table `counters` — schéma défini par les migrations (src/migrations). */
const Counter = sequelize.define('Counter', {
  scope: { type: DataTypes.STRING(160), primaryKey: true },
  value: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
}, {
  tableName: 'counters',
  timestamps: false,
});

module.exports = Counter;
