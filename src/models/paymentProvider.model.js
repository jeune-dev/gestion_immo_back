'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');
const { encrypt, decrypt } = require('../utils/cryptoField.js');

/** Table `payment_providers` — schéma défini par les migrations (src/migrations). */
const PaymentProvider = sequelize.define('PaymentProvider', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  owner_id: { type: DataTypes.UUID, allowNull: false },
  provider: { type: DataTypes.STRING(15), allowNull: false },
  mode: { type: DataTypes.STRING(10), allowNull: false },
  label: { type: DataTypes.STRING(100) },
  account_number: { type: DataTypes.STRING(30) },
  // Clés API du propriétaire (PayDunya, Wave) : objet JSON chiffré au repos.
  // Jamais renvoyé par l'API (voir toJSON).
  credentials: {
    type: DataTypes.TEXT,
    get() {
      const brut = this.getDataValue('credentials');
      return brut ? JSON.parse(decrypt(brut)) : null;
    },
    set(valeur) {
      this.setDataValue('credentials', valeur ? encrypt(JSON.stringify(valeur)) : null);
    },
  },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  tableName: 'payment_providers',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

PaymentProvider.prototype.toJSON = function toJSON() {
  const valeurs = { ...this.get({ plain: true }) };
  const configure = Boolean(this.getDataValue('credentials'));
  delete valeurs.credentials;
  valeurs.credentials_configured = configure;
  return valeurs;
};

module.exports = PaymentProvider;
