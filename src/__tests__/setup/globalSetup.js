'use strict';

/**
 * Prépare les bases de test (une seule fois, avant toute la suite).
 *
 * 1. Base MODÈLE (`DB_NAME` de .env.test) : schéma vidé, migrations et
 *    seeders rejoués, rôles synchronisés — exactement la séquence du
 *    déploiement (docker-entrypoint.sh).
 * 2. Une base PAR WORKER Jest (`<modèle>_w1`, `_w2`…), clonée du modèle par
 *    `CREATE DATABASE … TEMPLATE` (instantané). Chaque worker travaille sur sa
 *    propre base : les tests peuvent tourner en parallèle sans se partager
 *    d'état (paramètres plateforme, modèles de bail publiés, plans…).
 *
 * Sécurité : refuse toute base dont le nom ne contient pas « test » — la base
 * de production ne peut jamais être touchée.
 *
 * Un lancement limité aux tests unitaires (`--selectProjects unit`) ne touche
 * pas du tout à la base.
 */
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async (globalConfig) => {
  const projets = globalConfig?.selectProjects;
  if (Array.isArray(projets) && projets.length && projets.every((p) => p === 'unit')) return;

  require('./env.js');
  // Relance dans le même processus (mode --watch) : revenir au propriétaire.
  if (process.env.DB_ADMIN_USER) {
    process.env.DB_USER = process.env.DB_ADMIN_USER;
    process.env.DB_PASSWORD = process.env.DB_ADMIN_PASSWORD;
  }
  const modele = process.env.DB_NAME_MODELE;
  if (!/test/i.test(modele || '')) {
    throw new Error(`Base de test refusée (« ${modele} ») : DB_NAME doit contenir « test ». Créez .env.test.`);
  }

  const { Sequelize } = require('sequelize');
  const connexion = (base) => new Sequelize(base, process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), dialect: 'postgres', logging: false,
  });

  // 1. Base modèle.
  const cible = connexion(modele);
  await cible.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await cible.close();

  const racine = path.resolve(__dirname, '..', '..', '..');
  const cli = path.join(racine, 'node_modules', 'sequelize-cli', 'lib', 'sequelize');
  const env = { ...process.env, NODE_ENV: 'test', DB_NAME: modele };
  execFileSync(process.execPath, [cli, 'db:migrate'], { cwd: racine, env, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'db:seed:all'], { cwd: racine, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['-e', "require('./src/scripts/initialiser.js').synchroniserRoles().then(() => require('./src/config/db.js').close())"], { cwd: racine, env, stdio: 'pipe' });

  // 2. Une base par worker, clonée du modèle (le modèle ne doit avoir aucune connexion ouverte).
  const workers = Math.max(1, Number(globalConfig?.maxWorkers) || 1);
  const admin = connexion('postgres');
  for (let i = 1; i <= workers; i += 1) {
    const base = `${modele}_w${i}`;
    await admin.query(`DROP DATABASE IF EXISTS "${base}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${base}" TEMPLATE "${modele}"`);
  }
  await admin.close();

  // 3. Les tests tournent avec le RÔLE APPLICATIF à privilèges minimaux, comme
  //    l'API en production (constat M5) : tout droit manquant ou excessif se
  //    voit ici. Le propriétaire reste disponible (DB_ADMIN_USER) pour les
  //    rares tests qui exercent le schéma (cycle de migration). Désactivable :
  //    TEST_ROLE_APPLICATIF=0.
  if (process.env.TEST_ROLE_APPLICATIF !== '0') {
    const { configurerRoleApplicatif } = require('../../scripts/rolesBase.js');
    const role = `${modele}_app`.toLowerCase().slice(0, 63);
    const motDePasse = require('crypto').randomBytes(24).toString('hex');
    for (let i = 1; i <= workers; i += 1) {
      const base = `${modele}_w${i}`;
      const clone = connexion(base);
      await configurerRoleApplicatif(clone, { role, motDePasse, base });
      await clone.close();
    }
    // Hérité par les workers (créés après globalSetup) ; dotenv n'écrase pas.
    process.env.DB_ADMIN_USER = process.env.DB_USER;
    process.env.DB_ADMIN_PASSWORD = process.env.DB_PASSWORD;
    process.env.DB_USER = role;
    process.env.DB_PASSWORD = motDePasse;
  }

  // Couverture des routes : les fichiers d'impacts de l'exécution précédente sont effacés.
  const fs = require('fs');
  fs.rmSync(path.join(racine, 'tmp', 'route-hits'), { recursive: true, force: true });
};
