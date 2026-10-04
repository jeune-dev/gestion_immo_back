'use strict';

const { QueryTypes } = require('sequelize');
const { fermer, sequelize } = require('../../../setup/helpers.js');

/**
 * Audit #14 (MOYENNE) — index manquants.
 *   - La liste des artisans calcule, PAR LIGNE, le total dépensé
 *     (sous-requête corrélée sur expenses.contractor_id) : sans index, un
 *     parcours complet de `expenses` par artisan affiché.
 *   - L'annulation d'une facture commune cherche les transactions en cours
 *     par `payment_transactions.charge_id`.
 * Migration 20260928000007-index-audit.js : deux index PARTIELS.
 */

const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

afterAll(fermer);

describe('Index de l’audit (migration 20260928000007)', () => {
  test('expenses_contractor_idx : expenses (contractor_id) limité aux dépenses valides', async () => {
    const [index] = await q("SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'expenses_contractor_idx'");
    expect(index).toBeTruthy();
    expect(index.tablename).toBe('expenses');
    expect(index.indexdef).toMatch(/\(contractor_id\)/);
    expect(index.indexdef).toMatch(/WHERE .*status.*'valide'/);
  });

  test('payment_transactions_charge_idx : payment_transactions (charge_id) limité aux lignes qui visent une charge', async () => {
    const [index] = await q("SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'payment_transactions_charge_idx'");
    expect(index).toBeTruthy();
    expect(index.tablename).toBe('payment_transactions');
    expect(index.indexdef).toMatch(/\(charge_id\)/);
    expect(index.indexdef).toMatch(/WHERE .*charge_id IS NOT NULL/);
  });

  test('la migration est enregistrée et réversible (down supprime exactement ces deux index)', async () => {
    const [{ n }] = await q("SELECT count(*)::int AS n FROM sequelize_meta WHERE name = '20260928000007-index-audit.js'");
    expect(n).toBe(1);
    const migration = require('../../../../migrations/20260928000007-index-audit.js');
    const executees = [];
    const faux = {
      sequelize: {
        transaction: async (fn) => fn({}),
        query: async (sql) => { executees.push(sql); return [[], {}]; },
      },
    };
    await migration.down(faux, require('sequelize'));
    expect(executees.join('\n')).toMatch(/DROP INDEX IF EXISTS expenses_contractor_idx/);
    expect(executees.join('\n')).toMatch(/DROP INDEX IF EXISTS payment_transactions_charge_idx/);
  });

  test('cycle réel down → up sur la base : index retirés puis recréés à l’identique', async () => {
    const migration = require('../../../../migrations/20260928000007-index-audit.js');
    // Une migration modifie le SCHÉMA : elle s'exécute avec le rôle
    // PROPRIÉTAIRE, comme au démarrage du conteneur — le rôle applicatif de
    // l'API (et de la suite de tests) n'a volontairement aucun droit DDL.
    const { Sequelize } = require('sequelize');
    const proprietaire = new Sequelize(process.env.DB_NAME, process.env.DB_ADMIN_USER || process.env.DB_USER, process.env.DB_ADMIN_PASSWORD || process.env.DB_PASSWORD, {
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), dialect: 'postgres', logging: false,
    });
    const qi = proprietaire.getQueryInterface();
    const definitions = () => q("SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('expenses_contractor_idx', 'payment_transactions_charge_idx') ORDER BY indexname");
    const avant = await definitions();
    expect(avant).toHaveLength(2);
    try {
      await migration.down(qi, require('sequelize'));
      expect(await definitions()).toEqual([]);
    } finally {
      if ((await definitions()).length === 0) await migration.up(qi, require('sequelize'));
      await proprietaire.close();
    }
    expect(await definitions()).toEqual(avant);
  });

  test('le planificateur peut utiliser l’index pour la sous-requête « total dépensé » d’un artisan', async () => {
    const plan = await sequelize.transaction(async (t) => {
      await sequelize.query('SET LOCAL enable_seqscan = off', { transaction: t });
      return sequelize.query(
        "EXPLAIN SELECT COALESCE(sum(e.amount), 0) FROM expenses e WHERE e.contractor_id = gen_random_uuid() AND e.status = 'valide'",
        { type: QueryTypes.SELECT, transaction: t }
      );
    });
    expect(plan.map((l) => l['QUERY PLAN']).join('\n')).toMatch(/expenses_contractor_idx/);
  });
});
