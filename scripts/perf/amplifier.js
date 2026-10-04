'use strict';

/**
 * Base AMPLIFIÉE (projection à grande échelle) — après scripts/perf/peupler.js.
 *
 *   node scripts/perf/amplifier.js
 *   node scripts/perf/audit-sql.js --base gestion_imo_perf_x10_test
 *
 * Copie `gestion_imo_perf_test` en `gestion_imo_perf_x10_test` puis y
 * multiplie, en SQL direct, les tables qui grossissent sans fin :
 *   - échéances du GROS propriétaire : 20 ans d'échéances futures sur ses
 *     200 baux (≈ 53 000 lignes pour un seul compte) ;
 *   - journal d'audit de la plateforme : ×55 (≈ 500 000 lignes) ;
 *   - notifications du gros propriétaire : ≈ 50 000 ;
 *   - mouvements de caisse du gros propriétaire : ×75.
 * But : vérifier que les listes paginées gardent un coût CONSTANT (index
 * adaptés au tri) quand un compte ou la plateforme vieillit de plusieurs années.
 */
const BASE = 'gestion_imo_perf_test';
const CIBLE = 'gestion_imo_perf_x10_test';

process.env.DB_NAME = BASE;
require('../../src/__tests__/setup/env.js');
const { Sequelize } = require('sequelize');

const connexion = (base) => new Sequelize(base, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), dialect: 'postgres', logging: false,
});

/** Duplique les lignes `where` de `table` `fois` fois, `dates` décalées de n jours / mois. */
async function dupliquer(db, table, where, fois, { decalages = {}, remplacements = {} } = {}) {
  const [colonnes] = await db.query(
    'SELECT column_name, data_type, column_default, is_identity FROM information_schema.columns WHERE table_name = :t ORDER BY ordinal_position',
    { replacements: { t: table } }
  );
  const cibles = [];
  const valeurs = [];
  for (const c of colonnes) {
    if (c.column_name === 'id') {
      if (c.is_identity === 'YES' || /nextval/.test(c.column_default || '')) continue;
      cibles.push('id');
      valeurs.push(c.data_type === 'uuid' ? 'gen_random_uuid()' : 'DEFAULT');
      continue;
    }
    cibles.push(`"${c.column_name}"`);
    if (remplacements[c.column_name]) valeurs.push(remplacements[c.column_name]);
    else if (decalages[c.column_name]) valeurs.push(`x."${c.column_name}" - (n * ${decalages[c.column_name]})`);
    else valeurs.push(`x."${c.column_name}"`);
  }
  const [, meta] = await db.query(
    `INSERT INTO ${table} (${cibles.join(', ')}) SELECT ${valeurs.join(', ')} FROM ${table} x CROSS JOIN generate_series(1, ${fois}) n WHERE ${where}`
  );
  return meta?.rowCount ?? 0;
}

async function main() {
  const admin = connexion('postgres');
  await admin.query(`DROP DATABASE IF EXISTS "${CIBLE}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${CIBLE}" TEMPLATE "${BASE}"`);
  await admin.close();

  const db = connexion(CIBLE);
  const [[gros]] = await db.query(`SELECT o.id AS owner_id, m.user_id FROM owners o JOIN owner_members m ON m.owner_id = o.id
    ORDER BY (SELECT count(*) FROM leases l WHERE l.owner_id = o.id) DESC LIMIT 1`);
  const r = { owner: gros.owner_id };

  // 20 ans d'échéances futures (une par mois et par bail).
  const [, e] = await db.query(`
    INSERT INTO rent_schedules (owner_id, lease_id, apartment_id, tenant_id, period_start, period_end, due_date,
                                rent_amount, charges_amount, amount_due, amount_paid, status, label)
    SELECT l.owner_id, l.id, l.apartment_id, l.tenant_id, d::date, (d + interval '1 month' - interval '1 day')::date,
           (d + interval '4 days')::date, l.rent_amount, 0, l.rent_amount, 0, 'a_venir', to_char(d, 'MM/YYYY')
      FROM leases l CROSS JOIN generate_series('2027-11-01'::date, '2047-10-01'::date, interval '1 month') d
     WHERE l.owner_id = :o AND l.status = 'actif'`, { replacements: { o: gros.owner_id } });
  r.echeances = e?.rowCount;

  r.journalAudit = await dupliquer(db, 'audit_logs', 'TRUE', 54, { decalages: { created_at: "interval '1 day'" } });
  r.notifications = await dupliquer(db, 'notifications', `x.user_id = '${gros.user_id}'`, 5000, { decalages: { created_at: "interval '1 hour'" } });
  r.caisse = await dupliquer(db, 'cash_movements', `x.owner_id = '${gros.owner_id}'`, 74, {
    decalages: { occurred_on: 7, created_at: "interval '7 days'" },
    remplacements: { source_type: "'manuel'", source_id: 'NULL' },
  });
  await db.query('ANALYZE');
  const [[n]] = await db.query(`SELECT (SELECT count(*) FROM rent_schedules WHERE owner_id = :o)::int AS echeances_gros,
    (SELECT count(*) FROM audit_logs)::int AS journal_audit, (SELECT count(*) FROM notifications)::int AS notifications,
    (SELECT count(*) FROM cash_movements WHERE owner_id = :o)::int AS caisse_gros`, { replacements: { o: gros.owner_id } });
  process.stdout.write(`Base ${CIBLE} : ${JSON.stringify(n)}\n`);
  await db.close();
}

main().catch((e) => {
  process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
