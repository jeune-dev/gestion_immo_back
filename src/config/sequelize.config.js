'use strict';

require('dotenv').config({ quiet: true });

/**
 * Configuration sequelize-cli (db:migrate, db:seed:all).
 * Les trois environnements lisent les MÊMES variables : c'est le fichier .env
 * (ou l'environnement du conteneur) qui change, jamais ce fichier.
 */
const ssl = process.env.DB_SSL_CA
  ? {
    require: true,
    rejectUnauthorized: true,
    ca: process.env.DB_SSL_CA.startsWith('-----')
      ? process.env.DB_SSL_CA
      : Buffer.from(process.env.DB_SSL_CA, 'base64').toString('utf-8'),
  }
  : false;

const base = {
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  dialect: 'postgres',
  logging: false,
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_data',
};

module.exports = {
  development: base,
  test: base,
  production: { ...base, dialectOptions: ssl ? { ssl } : {} },
};
