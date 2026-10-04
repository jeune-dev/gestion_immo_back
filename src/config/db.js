'use strict';

require('dotenv').config({ quiet: true });
const pg = require('pg');
const { Sequelize } = require('sequelize');

// ── Types numériques ─────────────────────────────────────────────────────────
// Les montants sont des FCFA ENTIERS stockés en BIGINT : le pilote `pg` les rend
// sous forme de chaîne (int8 dépasse 2^53 en théorie). Un loyer ou un cumul de
// caisse reste très loin de 2^53 (9 × 10^15 FCFA) : on les convertit en nombre,
// sans quoi chaque addition dans un service deviendrait une concaténation.
// 20 = int8 (BIGINT, COUNT(*)), 1700 = numeric (surfaces, coefficients).
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

function buildSslConfig() {
  // Pas de SSL si PostgreSQL est sur le même hôte (réseau Docker ou loopback).
  if (!process.env.DB_SSL_CA || process.env.DB_SSL_CA.trim() === '') return false;
  const raw = process.env.DB_SSL_CA.trim();
  return {
    require: true,
    rejectUnauthorized: true,
    ca: raw.startsWith('-----') ? raw : Buffer.from(raw, 'base64').toString('utf-8'),
  };
}

const sslConfig = buildSslConfig();

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    dialect: 'postgres',
    // Journal SQL (diagnostic uniquement) : via le logger, jamais la console.
    logging: process.env.DB_LOG_SQL === 'true' ? (sql) => require('../utils/logger.js').debug(sql) : false,

    // Délais repris de Widjila (audit performance) : seules ces clés sont
    // transmises au pilote par Sequelize.
    //   - connectionTimeoutMillis : base injoignable → échec en 5 s ;
    //   - statement_timeout : une requête pathologique est tuée côté serveur ;
    //   - idle_in_transaction_session_timeout : une transaction oubliée ouverte
    //     rend sa connexion au pool.
    dialectOptions: {
      ...(sslConfig ? { ssl: sslConfig } : {}),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '5000', 10),
      statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000', 10),
      idle_in_transaction_session_timeout: parseInt(process.env.DB_IDLE_TX_TIMEOUT_MS || '60000', 10),
    },

    // Pool PAR PROCESS : total = DB_POOL_MAX × workers PM2. À garder sous
    // `max_connections` de PostgreSQL moins une réserve (migrations, psql).
    pool: {
      max: parseInt(process.env.DB_POOL_MAX || '20', 10),
      min: parseInt(process.env.DB_POOL_MIN || '2', 10),
      acquire: parseInt(process.env.DB_POOL_ACQUIRE_MS || '10000', 10),
      idle: 10000,
    },

    define: {
      freezeTableName: true,
      underscored: true,
      timestamps: true,
    },
  }
);

// Sequelize installe SES analyseurs par connexion (table `oidParserMap`), qui
// masquent ceux de `pg` : NUMERIC (oid 1700) y est rendu en CHAÎNE. Or
// `SUM(bigint)` et `AVG()` renvoient du NUMERIC — un total de loyers arrivait
// en « "350000" » et une addition devenait une concaténation. On impose la
// conversion en nombre, y compris si Sequelize rafraîchit sa table.
const versNombre = (v) => (v === null ? null : Number(v));
const gestionnaire = sequelize.connectionManager;
const rafraichirOrigine = gestionnaire._refreshTypeParser.bind(gestionnaire);
gestionnaire._refreshTypeParser = (dataType) => {
  rafraichirOrigine(dataType);
  gestionnaire.oidParserMap.set(1700, versNombre);
};
gestionnaire.oidParserMap.set(1700, versNombre);

module.exports = sequelize;
