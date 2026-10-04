'use strict';

const { Sequelize } = require('sequelize');
const crypto = require('crypto');
const { sequelize, fermer, nouveauProprietaire, compter } = require('../../setup/helpers.js');
const { configurerRoleApplicatif, verifierRoleApplicatif } = require('../../../scripts/rolesBase.js');

/**
 * CORRECTIFS M5 / M6 de l'audit de sécurité.
 *
 *   M5 — l'API ne se connecte plus avec le superutilisateur : rôle applicatif
 *        sans aucun droit sur le schéma. Toute la suite de tests tourne avec
 *        ce rôle (globalSetup) ; ce fichier vérifie ses limites exactes.
 *   M6 — journal d'audit en AJOUT SEUL : ni le rôle applicatif (droits), ni
 *        même le propriétaire (déclencheur) ne peuvent le modifier ou l'effacer.
 */

const connecter = (user, password) => new Sequelize(process.env.DB_NAME, user, password, {
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), dialect: 'postgres', logging: false,
});
const proprietaire = connecter(process.env.DB_ADMIN_USER || process.env.DB_USER, process.env.DB_ADMIN_PASSWORD || process.env.DB_PASSWORD);

afterAll(async () => {
  await proprietaire.close();
  await fermer();
});

/** Code SQLSTATE d'une requête refusée (ou null si elle passe). */
async function refus(connexion, sql, replacements) {
  try {
    await connexion.query(sql, { replacements });
    return null;
  } catch (err) {
    return err.parent?.code || err.original?.code || err.message;
  }
}

describe('Rôle applicatif (celui de l’API et de toute la suite de tests)', () => {
  test('la suite tourne bien avec un rôle NON privilégié', async () => {
    const { privilegie, role } = await verifierRoleApplicatif(sequelize, { production: true });
    expect(privilegie).toBe(false);
    expect(role).toBe(process.env.DB_USER);
    expect(role).not.toBe(process.env.DB_ADMIN_USER);
  });

  test('travail normal permis : lecture, écriture, séquences, verrous consultatifs, API', async () => {
    const p = await nouveauProprietaire();
    expect(await compter('users', 'id = :u', { u: p.user.id })).toBe(1);
    expect(await refus(sequelize, 'SELECT pg_advisory_xact_lock(42)')).toBeNull();
    expect(await refus(sequelize, "INSERT INTO audit_logs (action, details) VALUES ('test.role_applicatif', '{}')")).toBeNull();
  });

  test.each([
    ['modifier le journal d’audit', "UPDATE audit_logs SET action = 'efface' WHERE id = (SELECT min(id) FROM audit_logs)"],
    ['supprimer du journal d’audit', 'DELETE FROM audit_logs WHERE id = (SELECT min(id) FROM audit_logs)'],
    ['vider le journal d’audit', 'TRUNCATE audit_logs'],
    ['créer une table', 'CREATE TABLE intrus (id int)'],
    ['modifier le schéma', 'ALTER TABLE users ADD COLUMN intrus int'],
    ['supprimer une table', 'DROP TABLE notifications'],
    ['toucher à l’historique des migrations', "DELETE FROM sequelize_meta WHERE name LIKE '2026%'"],
    ['exécuter une commande système', "COPY (SELECT 1) TO PROGRAM 'echo intrus'"],
    ['lire un fichier du serveur', "SELECT pg_read_file('postgresql.conf')"],
    ['créer un rôle', "CREATE ROLE intrus LOGIN PASSWORD 'x'"],
    ['créer une base', 'CREATE DATABASE intrus'],
  ])('interdit : %s', async (_l, sql) => {
    expect(await refus(sequelize, sql)).toBe('42501'); // insufficient_privilege
  });

  test('en production, l’API refuse de démarrer avec un rôle privilégié', async () => {
    await expect(verifierRoleApplicatif(proprietaire, { production: true })).rejects.toThrow(/rôle privilégié/);
    await expect(verifierRoleApplicatif(proprietaire, { production: false })).resolves.toMatchObject({ privilegie: true });
  });
});

describe('Journal d’audit en ajout seul, MÊME pour le propriétaire du schéma (déclencheur)', () => {
  test.each([
    ['UPDATE', "UPDATE audit_logs SET action = 'efface' WHERE id = (SELECT min(id) FROM audit_logs)"],
    ['DELETE', 'DELETE FROM audit_logs WHERE id = (SELECT min(id) FROM audit_logs)'],
    ['TRUNCATE', 'TRUNCATE audit_logs'],
  ])('%s refusé', async (_l, sql) => {
    await proprietaire.query("INSERT INTO audit_logs (action) VALUES ('test.immuable')");
    const avant = await compter('audit_logs');
    expect(await refus(proprietaire, sql)).toBe('42501');
    expect(await compter('audit_logs')).toBe(avant);
  });
});

describe('Script de création du rôle (rolesBase.js)', () => {
  test('crée puis met à jour un rôle (idempotent), avec exactement les droits prévus', async () => {
    const role = `gi_verif_${crypto.randomBytes(4).toString('hex')}`;
    const motDePasse = crypto.randomBytes(16).toString('hex');
    try {
      expect(await configurerRoleApplicatif(proprietaire, { role, motDePasse, base: process.env.DB_NAME })).toEqual({ role, cree: true });
      expect(await configurerRoleApplicatif(proprietaire, { role, motDePasse, base: process.env.DB_NAME })).toEqual({ role, cree: false });
      const [[r]] = await proprietaire.query('SELECT rolsuper, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = :role', { replacements: { role } });
      expect(r).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true });
      const connexion = connecter(role, motDePasse);
      try {
        expect(await refus(connexion, 'SELECT count(*) FROM users')).toBeNull();
        expect(await refus(connexion, 'DELETE FROM audit_logs')).toBe('42501');
      } finally {
        await connexion.close();
      }
    } finally {
      await proprietaire.query(`DROP OWNED BY "${role}"`).catch(() => {});
      await proprietaire.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  });

  test.each([
    ['nom de rôle injecté', { role: 'x"; DROP TABLE users; --', motDePasse: 'a'.repeat(20), base: 'b' }, /rôle applicatif invalide/],
    ['mot de passe trop court', { role: 'gi_ok', motDePasse: 'court', base: 'b' }, /trop court/],
    ['nom de base injecté', { role: 'gi_ok', motDePasse: 'a'.repeat(20), base: 'b"; --' }, /base invalide/],
  ])('refus : %s', async (_l, parametres, message) => {
    await expect(configurerRoleApplicatif(proprietaire, parametres)).rejects.toThrow(message);
  });
});
