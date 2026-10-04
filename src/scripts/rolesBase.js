'use strict';

/**
 * Rôle PostgreSQL APPLICATIF à privilèges minimaux (constat M5 de l'audit).
 *
 * L'API ne se connecte plus avec le superutilisateur : une injection SQL ou
 * une dépendance compromise ne peut ni lire d'autres bases, ni exécuter des
 * commandes système (`COPY … TO PROGRAM`), ni modifier le schéma, ni effacer
 * le journal d'audit.
 *
 *   - propriétaire du schéma (DB_ADMIN_USER) : migrations, données de
 *     référence, création de ce rôle — uniquement au démarrage du conteneur ;
 *   - rôle applicatif (DB_USER) : SELECT / INSERT / UPDATE / DELETE sur les
 *     tables, séquences ; AUCUN droit de schéma ; journal d'audit en INSERT +
 *     SELECT seulement ; table des migrations en lecture seule.
 *
 * Idempotent (exécuté à chaque démarrage) : les tables créées par une future
 * migration reçoivent les mêmes droits (ALTER DEFAULT PRIVILEGES).
 *
 * Usage (docker-entrypoint.sh, avec les identifiants du PROPRIÉTAIRE) :
 *   DB_APP_USER=… DB_APP_PASSWORD=… node src/scripts/rolesBase.js
 */

const IDENTIFIANT = /^[a-z_][a-z0-9_]{0,62}$/;
const TABLES_LECTURE_SEULE = ['sequelize_meta', 'sequelize_data'];

/**
 * @param {import('sequelize').Sequelize} sequelize  connexion du PROPRIÉTAIRE du schéma
 * @param {{ role: string, motDePasse: string, base: string }} p
 */
async function configurerRoleApplicatif(sequelize, { role, motDePasse, base }) {
  if (!IDENTIFIANT.test(role || '')) throw new Error(`Nom de rôle applicatif invalide : « ${role} »`);
  if (!motDePasse || motDePasse.length < 16) throw new Error('Mot de passe du rôle applicatif absent ou trop court (16 caractères minimum).');
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(base || '')) throw new Error(`Nom de base invalide : « ${base} »`);

  const [[{ existe }]] = await sequelize.query('SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role) AS existe', { replacements: { role } });
  // Les ordres de rôle n'acceptent pas de paramètres liés : identifiant validé
  // par motif ci-dessus, mot de passe échappé par le pilote.
  const attributs = `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${sequelize.escape(motDePasse)}`;
  const instructions = [
    existe ? `ALTER ROLE "${role}" WITH ${attributs}` : `CREATE ROLE "${role}" WITH ${attributs}`,
    `REVOKE ALL ON DATABASE "${base}" FROM "${role}"`,
    `GRANT CONNECT, TEMPORARY ON DATABASE "${base}" TO "${role}"`,
    `REVOKE CREATE ON SCHEMA public FROM "${role}"`,
    `GRANT USAGE ON SCHEMA public TO "${role}"`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${role}"`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${role}"`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "${role}"`,
    // Journal d'audit : ajout et lecture seulement (le déclencheur de la
    // migration 010 le protège aussi contre tout autre rôle).
    `REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM "${role}"`,
  ];
  const [presentes] = await sequelize.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN (:tables)",
    { replacements: { tables: TABLES_LECTURE_SEULE } }
  );
  for (const { tablename } of presentes) {
    instructions.push(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "${tablename}" FROM "${role}"`);
  }
  await sequelize.transaction(async (transaction) => {
    for (const sql of instructions) await sequelize.query(sql, { transaction });
  });
  return { role, cree: !existe };
}

/**
 * Contrôle au démarrage de l'API : en production, refus de tourner avec un
 * rôle superutilisateur ou capable de créer des rôles/bases (sauf dérogation
 * explicite DB_AUTORISER_SUPERUTILISATEUR=1, à réserver à un dépannage).
 */
async function verifierRoleApplicatif(sequelize, { production = process.env.NODE_ENV === 'production' } = {}) {
  const [[r]] = await sequelize.query(
    'SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user'
  );
  const trop = r.rolsuper || r.rolcreaterole || r.rolcreatedb;
  if (trop && production && process.env.DB_AUTORISER_SUPERUTILISATEUR !== '1') {
    throw new Error(
      `L'API ne doit pas se connecter à PostgreSQL avec un rôle privilégié (« ${r.rolname} »). `
      + 'Utilisez le rôle applicatif (DB_USER) créé par src/scripts/rolesBase.js ; DB_ADMIN_USER sert uniquement aux migrations.'
    );
  }
  return { role: r.rolname, privilegie: trop };
}

module.exports = { configurerRoleApplicatif, verifierRoleApplicatif };

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const sequelize = require('../config/db.js');
  const logger = require('../utils/logger.js');
  configurerRoleApplicatif(sequelize, {
    role: process.env.DB_APP_USER,
    motDePasse: process.env.DB_APP_PASSWORD,
    base: process.env.DB_NAME,
  })
    .then(({ role, cree }) => logger.info(`[roles] Rôle applicatif « ${role} » ${cree ? 'créé' : 'mis à jour'} (privilèges minimaux)`))
    .then(() => sequelize.close())
    .then(() => process.exit(0))
    .catch(async (err) => {
      logger.error(`[roles] Échec : ${err.message}`);
      await sequelize.close().catch(() => {});
      process.exit(1);
    });
}
