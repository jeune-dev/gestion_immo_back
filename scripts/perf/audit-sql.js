'use strict';

/**
 * AUDIT SQL sur la base de volume (après scripts/perf/peupler.js).
 *
 *   node scripts/perf/audit-sql.js [--repetitions 5] [--seuil-ms 150]
 *
 * Pour chaque route GET de l'API, avec le compte concerné (GROS propriétaire,
 * propriétaire courant, locataire, super admin) :
 *   - temps de réponse médian et maximal sur N appels ;
 *   - nombre de requêtes SQL et durée de chacune ;
 * puis `EXPLAIN (ANALYZE, BUFFERS)` des requêtes les plus lentes : tout
 * parcours séquentiel (Seq Scan) d'une table volumineuse est signalé.
 * Les tâches planifiées (jobs) sont chronométrées sur le même volume.
 *
 * Code de sortie 1 si une route dépasse le seuil ou si un Seq Scan suspect
 * est trouvé : utilisable en CI de performance.
 * Rapport : tmp/perf-audit-sql.json (+ résumé sur la sortie standard).
 */
const path = require('path');
const fs = require('fs');

const arg = (nom, defaut) => {
  const i = process.argv.indexOf(`--${nom}`);
  if (i < 0) return defaut;
  return typeof defaut === 'number' ? Number(process.argv[i + 1]) : process.argv[i + 1];
};
// --base gestion_imo_perf_x10_test : base amplifiée (scripts/perf/amplifier.js).
const BASE = arg('base', 'gestion_imo_perf_test');
if (!/perf.*test/.test(BASE)) throw new Error(`Base refusée : ${BASE}`);
const REPETITIONS = arg('repetitions', 5);
const SEUIL_MS = arg('seuil-ms', 150);
// En dessous, une table est petite : un Seq Scan y est le bon plan.
const LIGNES_TABLE_VOLUMINEUSE = 2000;

/**
 * Parcours séquentiels SUSPECTS d'un plan EXPLAIN ANALYZE. Un Seq Scan n'est
 * pas une faute en soi : quand un compte possède 90 % d'une table, la lire
 * en entier est le plan optimal. Il l'est quand :
 *   - il écarte l'essentiel de ce qu'il lit (filtre sélectif sans index) ;
 *   - ou il lit toute une table pour n'en rendre qu'une page (tri sans index
 *     adapté sous un LIMIT : coût proportionnel à la table, pas à la page).
 */
function seqScansSuspects(plan, taille) {
  const lignes = plan.split('\n');
  const limite = Number((plan.match(/^\s*Limit .*?actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/m) || [])[1]);
  const suspects = [];
  lignes.forEach((ligne, i) => {
    const m = ligne.match(/Seq Scan on (\w+).*?actual time=[\d.]+\.\.[\d.]+ rows=(\d+) loops=(\d+)/);
    if (!m || (taille[m[1]] || 0) < LIGNES_TABLE_VOLUMINEUSE) return;
    const lues = Number(m[2]) * Number(m[3]);
    let ecartees = 0;
    for (let j = i + 1; j < lignes.length && !/->/.test(lignes[j]); j += 1) {
      const r = lignes[j].match(/Rows Removed by Filter: (\d+)/);
      if (r) ecartees = Number(r[1]) * Number(m[3]);
    }
    if (ecartees > LIGNES_TABLE_VOLUMINEUSE && ecartees > 2 * lues) suspects.push(`${m[1]} (filtre : ${lues} gardées / ${ecartees} écartées)`);
    else if (limite && lues > LIGNES_TABLE_VOLUMINEUSE && lues > 20 * limite) suspects.push(`${m[1]} (${lues} lignes lues pour une page de ${limite})`);
  });
  return suspects;
}

process.env.DB_NAME = BASE;
process.env.UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'tmp', 'uploads-gestion_imo_perf_test');
require('../../src/__tests__/setup/env.js');

const { listerRoutes } = require('../lister-routes.js');
const h = require('../../src/__tests__/setup/helpers.js');
const { resoudreParametres } = require('../../src/__tests__/setup/jeuComplet.js');
const { normaliser } = require('../../src/__tests__/setup/compteurRequetes.js');

const { api, sequelize } = h;

// ── Chronométrage de chaque requête SQL ────────────────────────────────────
let journal = null;
const debuts = new WeakMap();
sequelize.addHook('beforeQuery', (options, query) => { if (journal) debuts.set(query, process.hrtime.bigint()); });
sequelize.addHook('afterQuery', (options, query) => {
  if (!journal || !debuts.has(query)) return;
  journal.push({ sql: query.sql, ms: Number(process.hrtime.bigint() - debuts.get(query)) / 1e6, bind: Boolean(options?.bind) });
});

const mediane = (t) => [...t].sort((a, b) => a - b)[Math.floor(t.length / 2)];

/** Identifiants réels du compte, pour remplir les routes paramétrées. */
async function idsDu(ownerId, tenantUserId) {
  const un = async (sql) => (await sequelize.query(sql, { replacements: { o: ownerId, u: tenantUserId } }))[0][0]?.id;
  const lease = await un('SELECT l.id FROM leases l JOIN tenants t ON t.id = l.tenant_id WHERE l.owner_id = :o AND t.user_id = :u LIMIT 1');
  const r = { lease };
  const requetes = {
    building: 'SELECT id FROM buildings WHERE owner_id = :o ORDER BY created_at LIMIT 1',
    apartment: 'SELECT apartment_id AS id FROM leases WHERE id = (SELECT l.id FROM leases l JOIN tenants t ON t.id = l.tenant_id WHERE l.owner_id = :o AND t.user_id = :u LIMIT 1)',
    tenant: 'SELECT id FROM tenants WHERE owner_id = :o AND user_id = :u',
    schedule: 'SELECT s.id FROM rent_schedules s JOIN tenants t ON t.id = s.tenant_id WHERE s.owner_id = :o AND t.user_id = :u ORDER BY s.due_date LIMIT 1',
    payment: 'SELECT p.id FROM rent_payments p JOIN tenants t ON t.id = p.tenant_id WHERE p.owner_id = :o AND t.user_id = :u LIMIT 1',
    receipt: 'SELECT r.id FROM receipts r JOIN tenants t ON t.id = r.tenant_id WHERE r.owner_id = :o AND t.user_id = :u LIMIT 1',
    deposit: 'SELECT id FROM deposits WHERE owner_id = :o LIMIT 1',
    workOrder: 'SELECT id FROM work_orders WHERE owner_id = :o LIMIT 1',
    expense: 'SELECT id FROM expenses WHERE owner_id = :o LIMIT 1',
    cashMovement: 'SELECT id FROM cash_movements WHERE owner_id = :o LIMIT 1',
    incident: 'SELECT id FROM incidents WHERE owner_id = :o LIMIT 1',
    thread: 'SELECT id FROM message_threads WHERE owner_id = :o LIMIT 1',
    notification: 'SELECT id FROM notifications WHERE user_id = :u LIMIT 1',
  };
  for (const [cle, sql] of Object.entries(requetes)) r[cle] = await un(sql);
  return r;
}

async function connecter(identifiants) {
  const res = await api().post('/api/v1/auth/connexion').send({ identifiant: identifiants.identifiant || identifiants.phone, password: identifiants.password });
  if (!res.body.data?.access_token) throw new Error(`Connexion : ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return h.bearer(res.body.data.access_token);
}

async function main() {
  const fichier = path.resolve(__dirname, '..', '..', 'tmp', 'perf-comptes.json');
  if (!fs.existsSync(fichier)) throw new Error('Lancez d’abord scripts/perf/peupler.js');
  const { comptes } = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  const gros = comptes.find((c) => c.gros);
  const courant = comptes.find((c) => !c.gros);

  const admin = await h.superAdmin();
  const profils = {};
  for (const [nom, c] of [['gros', gros], ['courant', courant]]) {
    const hp = await connecter(c.proprietaire);
    const hl = await connecter(c.locataire);
    const [[{ user_id: tenantUser }]] = await sequelize.query('SELECT t.user_id FROM tenants t WHERE t.owner_id = :o AND t.user_id IS NOT NULL LIMIT 1', { replacements: { o: c.ownerId } });
    profils[nom] = { proprietaire: hp, locataire: hl, ids: await idsDu(c.ownerId, tenantUser), ownerId: c.ownerId };
  }

  const PERIODE = 'du=2025-10-01&au=2026-09-30';
  const requete = (chemin, ids) => ({
    '/api/v1/appartements/:id/rentabilite': PERIODE,
    '/api/v1/caisse/synthese': PERIODE,
    '/api/v1/rapports/financier': PERIODE,
    '/api/v1/rapports/immobilier': PERIODE,
    '/api/v1/rapports/travaux': PERIODE,
    '/api/v1/rapports/locataires': PERIODE,
    '/api/v1/rapports/rentabilite': PERIODE,
    '/api/v1/locataire/paiements/moyens': `lease_id=${ids.lease}`,
  }[chemin]);

  const routes = listerRoutes()
    .filter((r) => r.methode === 'GET' && r.chemin.startsWith('/api/v1/'))
    .map((r) => r.chemin.replace(/\/$/, ''))
    .filter((c) => !/webhooks|referentiels|abonnement\/plans|modeles-bail\/:id|plans\/:id|etats-des-lieux|factures-communes\/:id|\/caution|cautions\/:id|transactions\/:id|charges\/:id|documents\/:id/.test(c));

  const resultats = [];
  const nonMesurees = [];
  const appeler = async (url, entete) => {
    const t0 = process.hrtime.bigint();
    const res = await api().get(url).set(entete);
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.status };
  };

  for (const chemin of routes) {
    const cibles = chemin.startsWith('/api/v1/admin/')
      ? [['admin', admin.h, { proprietaires: gros.ownerId, abonnements: null, utilisateurs: admin.user.id }]]
      : ['gros', 'courant'].map((n) => [n, chemin.startsWith('/api/v1/locataire/') ? profils[n].locataire : profils[n].proprietaire, profils[n].ids]);
    for (const [compte, entete, ids] of cibles) {
      let url = chemin;
      if (chemin.startsWith('/api/v1/admin/') && chemin.includes(':id')) {
        const id = ids[chemin.split('/')[4]];
        url = id ? chemin.replace(':id', id) : null;
      } else if (chemin.includes(':')) {
        url = resoudreParametres(chemin, ids);
      }
      if (!url) { nonMesurees.push(`${chemin} (${compte})`); continue; }
      const q = requete(chemin, ids);
      if (q) url = `${url}?${q}`;
      if (/\/(immeubles|appartements|locataires|baux|echeances|paiements|quittances|depenses|caisse|journal-audit|proprietaires|utilisateurs)$/.test(chemin)) url += `${url.includes('?') ? '&' : '?'}limit=100`;

      await appeler(url, entete); // échauffement (caches, plans préparés)
      const temps = [];
      let statut;
      let requetes = [];
      for (let i = 0; i < REPETITIONS; i += 1) {
        journal = [];
        const r = await appeler(url, entete);
        temps.push(r.ms);
        statut = r.status;
        requetes = journal;
        journal = null;
      }
      resultats.push({ route: chemin, compte, url, statut, medianeMs: mediane(temps), maxMs: Math.max(...temps), requetes });
    }
  }

  // ── EXPLAIN des requêtes les plus lentes ─────────────────────────────────
  const [tailles] = await sequelize.query("SELECT relname AS t, n_live_tup::int AS n FROM pg_stat_user_tables");
  const taille = Object.fromEntries(tailles.map((x) => [x.t, x.n]));
  const vues = new Map();
  for (const r of resultats) {
    for (const q of r.requetes) {
      if (q.bind || !/^\s*(SELECT|WITH)/i.test(q.sql)) continue;
      const f = normaliser(q.sql);
      const v = vues.get(f);
      if (!v || q.ms > v.ms) vues.set(f, { ...q, route: r.route });
    }
  }
  const lentes = [...vues.values()].sort((a, b) => b.ms - a.ms).slice(0, 40);
  const suspects = [];
  const plans = [];
  for (const q of lentes) {
    const sql = q.sql.replace(/;\s*$/, '');
    const [lignes] = await sequelize.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`);
    const plan = lignes.map((l) => l['QUERY PLAN']).join('\n');
    const scans = seqScansSuspects(plan, taille);
    const duree = Number((plan.match(/Execution Time: ([\d.]+) ms/) || [])[1]);
    plans.push({ route: q.route, ms: q.ms, executionMs: duree, seqScans: scans, sql: sql.slice(0, 600), plan });
    if (scans.length) suspects.push(`${q.route} : Seq Scan sur ${scans.join(', ')} (${duree} ms)\n    ${normaliser(sql).slice(0, 220)}`);
  }

  // ── Tâches planifiées sur le volume ──────────────────────────────────────
  const { TACHES } = require('../../src/jobs/index.js');
  const jobs = [];
  for (const t of TACHES) {
    journal = [];
    const t0 = Date.now();
    let erreur = null;
    try { await t.fn(); } catch (e) { erreur = e.message; }
    jobs.push({ job: t.nom, ms: Date.now() - t0, requetes: journal.length, erreur });
    journal = null;
  }

  const lentesRoutes = resultats.filter((r) => r.medianeMs > SEUIL_MS);
  const echecs = resultats.filter((r) => r.statut >= 400);
  const [[vol]] = await sequelize.query(`SELECT (SELECT count(*) FROM owners)::int AS proprietaires, (SELECT count(*) FROM leases)::int AS baux,
    (SELECT count(*) FROM rent_schedules)::int AS echeances, (SELECT count(*) FROM rent_payments)::int AS paiements,
    (SELECT count(*) FROM receipts)::int AS quittances, (SELECT count(*) FROM audit_logs)::int AS journal_audit`);
  const rapport = {
    date: new Date().toISOString(), volume: vol, seuilMs: SEUIL_MS, repetitions: REPETITIONS,
    routes: resultats.map(({ requetes, ...r }) => ({ ...r, nbRequetes: requetes.length, sqlMs: Math.round(requetes.reduce((s, q) => s + q.ms, 0)) })),
    nonMesurees, plans, suspects, jobs,
  };
  fs.writeFileSync(path.resolve(__dirname, '..', '..', 'tmp', `perf-audit-sql-${BASE}.json`), JSON.stringify(rapport, null, 2));

  const top = [...rapport.routes].sort((a, b) => b.medianeMs - a.medianeMs).slice(0, 15);
  const out = [
    `Volume : ${JSON.stringify(vol)}`,
    `Routes mesurées : ${resultats.length} (${REPETITIONS} appels chacune) — non mesurées : ${nonMesurees.length}`,
    `Médiane de toutes les routes : ${mediane(resultats.map((r) => r.medianeMs)).toFixed(1)} ms`,
    '', '15 routes les plus lentes (médiane / max / requêtes SQL) :',
    ...top.map((r) => `  ${r.medianeMs.toFixed(1).padStart(7)} ms ${r.maxMs.toFixed(1).padStart(7)} ms ${String(r.nbRequetes).padStart(3)}  ${r.compte.padEnd(7)} ${r.route}`),
    '', `Au-dessus du seuil (${SEUIL_MS} ms) : ${lentesRoutes.length}`, ...lentesRoutes.map((r) => `  ${r.route} (${r.compte}) ${r.medianeMs.toFixed(0)} ms`),
    `Réponses en erreur : ${echecs.length}`, ...echecs.map((r) => `  ${r.statut} ${r.url}`),
    '', `Parcours séquentiels suspects (filtre sans index, ou table entière lue pour une page) : ${suspects.length}`, ...suspects.map((s) => `  ${s}`),
    '', 'Tâches planifiées :', ...jobs.map((j) => `  ${j.job.padEnd(22)} ${String(j.ms).padStart(6)} ms ${String(j.requetes).padStart(6)} requêtes${j.erreur ? `  ERREUR ${j.erreur}` : ''}`),
  ];
  process.stdout.write(`${out.join('\n')}\n`);
  await h.fermer();
  process.exit(lentesRoutes.length || suspects.length || echecs.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${e.stack}\n`);
  process.exit(2);
});
