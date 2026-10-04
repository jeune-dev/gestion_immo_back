'use strict';

/**
 * TEST DE CHARGE sur la base de volume (après scripts/perf/peupler.js).
 *
 *   node scripts/perf/charge.js [--duree 60] [--reflexion-ms 0] [--locataires 50]
 *
 * Démarre le VRAI serveur HTTP (src/server.js, processus séparé) sur
 * `gestion_imo_perf_test`, connecte chaque propriétaire de la base (50 + le
 * gros) et un locataire par propriétaire, puis chacun enchaîne des appels
 * selon un MÉLANGE réaliste d'usage du mobile (tableau de bord, listes,
 * échéances, encaissements en espèces avec quittance PDF…) pendant la durée
 * demandée.
 *
 *   --reflexion-ms 0     : stress (chaque utilisateur rappelle dès la réponse)
 *   --reflexion-ms 1000  : usage soutenu réaliste (1 s entre deux écrans)
 *
 * Mesures : débit, latences p50 / p95 / p99 / max par groupe d'écrans,
 * erreurs (toute réponse ≥ 500 ou inattendue), mémoire du serveur.
 * Code de sortie 1 si erreurs serveur ou p95 global > --p95-max (800 ms).
 * Aucun outil externe : Node seul (http, keep-alive).
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BASE = 'gestion_imo_perf_test';
const arg = (nom, defaut) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 ? Number(process.argv[i + 1]) : defaut;
};
const DUREE_S = arg('duree', 60);
const REFLEXION_MS = arg('reflexion-ms', 0);
const NB_LOCATAIRES = arg('locataires', 50);
const P95_MAX = arg('p95-max', 800);
const PORT = arg('port', 3999);
// --profil : serveur sous profileur CPU (scripts/perf/profil-serveur.js → tmp/perf-profil.txt).
const PROFIL = process.argv.includes('--profil');
// --processus N : serveur en cluster de N processus, comme PM2 en production.
const PROCESSUS = arg('processus', 1);
// --multiplicateur k : k utilisateurs simultanés par compte (capacité).
const MULTIPLICATEUR = arg('multiplicateur', 1);

process.env.DB_NAME = BASE;
process.env.UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'tmp', `uploads-${BASE}`);
require('../../src/__tests__/setup/env.js');

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

function requete(methode, chemin, { jeton, corps, entetes = {} } = {}) {
  return new Promise((resolve) => {
    const donnees = corps ? Buffer.from(JSON.stringify(corps)) : null;
    const t0 = process.hrtime.bigint();
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: chemin, method: methode, agent,
      headers: {
        ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
        ...(donnees ? { 'Content-Type': 'application/json', 'Content-Length': donnees.length } : {}),
        ...entetes,
      },
    }, (res) => {
      const morceaux = [];
      res.on('data', (m) => morceaux.push(m));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        let body = null;
        if ((res.headers['content-type'] || '').includes('json')) {
          try { body = JSON.parse(Buffer.concat(morceaux).toString('utf8')); } catch { body = null; }
        }
        resolve({ status: res.statusCode, ms, body });
      });
    });
    req.on('error', (e) => resolve({ status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, erreur: e.message }));
    if (donnees) req.write(donnees);
    req.end();
  });
}

async function attendreServeur() {
  for (let i = 0; i < 120; i += 1) {
    const r = await requete('GET', '/health/live');
    if (r.status === 200) return;
    await new Promise((ok) => { setTimeout(ok, 500); });
  }
  throw new Error('Le serveur ne répond pas sur /health/live');
}

async function connecter(identifiant, password) {
  const r = await requete('POST', '/api/v1/auth/connexion', { corps: { identifiant, password } });
  if (!r.body?.data?.access_token) throw new Error(`Connexion ${identifiant} : ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.data.access_token;
}

const PERIODE = 'du=2025-10-01&au=2026-09-30';
/** Mélange d'écrans du PROPRIÉTAIRE (poids relatifs). */
const MELANGE_PROPRIETAIRE = [
  [15, 'tableau de bord', () => '/api/v1/dashboard'],
  [10, 'notifications', () => '/api/v1/notifications/compteur'],
  [10, 'listes patrimoine', () => ['/api/v1/immeubles', '/api/v1/appartements', '/api/v1/locataires', '/api/v1/baux'][Math.floor(Math.random() * 4)]],
  [8, 'recherche', () => `/api/v1/locataires?q=${encodeURIComponent(['Ndiaye', 'Mam', 'Diop', '77'][Math.floor(Math.random() * 4)])}`],
  [15, 'échéances', () => ['/api/v1/echeances', '/api/v1/echeances?impayes=true', '/api/v1/echeances?page=3'][Math.floor(Math.random() * 3)]],
  [10, 'paiements', () => ['/api/v1/paiements', '/api/v1/quittances'][Math.floor(Math.random() * 2)]],
  [6, 'caisse', () => ['/api/v1/caisse', `/api/v1/caisse/synthese?${PERIODE}`][Math.floor(Math.random() * 2)]],
  [4, 'rapports', () => [`/api/v1/rapports/financier?${PERIODE}`, `/api/v1/rapports/locataires?${PERIODE}`, `/api/v1/rapports/rentabilite?${PERIODE}`][Math.floor(Math.random() * 3)]],
  [4, 'détail bail', (u) => `/api/v1/baux/${u.leaseIds[Math.floor(Math.random() * u.leaseIds.length)]}`],
  [4, 'dépenses / travaux', () => ['/api/v1/depenses', '/api/v1/travaux', '/api/v1/incidents'][Math.floor(Math.random() * 3)]],
  [3, 'encaissement espèces', null],
];
/** Mélange d'écrans du LOCATAIRE. */
const MELANGE_LOCATAIRE = [
  [30, 'espace locataire', () => '/api/v1/locataire/accueil'],
  [25, 'mes échéances', () => '/api/v1/locataire/echeances'],
  [15, 'mes quittances', () => '/api/v1/locataire/quittances'],
  [15, 'notifications', () => '/api/v1/notifications/compteur'],
  [15, 'messagerie', () => '/api/v1/locataire/messagerie'],
];

function tirer(melange) {
  const total = melange.reduce((s, [p]) => s + p, 0);
  let x = Math.random() * total;
  for (const e of melange) { x -= e[0]; if (x <= 0) return e; }
  return melange[melange.length - 1];
}

// Démarrage : les utilisateurs arrivent étalés sur 2 s, et les 5 premières
// secondes (processus à froid, pools de connexions qui s'ouvrent) ne sont pas
// mesurées — sinon 101 premières requêtes simultanées font le p99.
const ECHAUFFEMENT_MS = arg('echauffement-s', 5) * 1000;
let mesureDes = Infinity;

const mesures = new Map(); // groupe → [ms]
const erreurs = [];
let attendues4xx = 0;
function noter(groupe, r, chemin) {
  if (Date.now() < mesureDes) return;
  if (!mesures.has(groupe)) mesures.set(groupe, []);
  mesures.get(groupe).push(r.ms);
  if (r.status === 0 || r.status >= 500) erreurs.push(`${r.status} ${chemin} ${r.erreur || r.body?.error?.code || ''}`);
  else if (r.status >= 400) attendues4xx += 1;
}

/** Encaisse en espèces la prochaine échéance ouverte d'un bail (Idempotency-Key, quittance PDF). */
async function encaisser(u) {
  const leaseId = u.leaseIds[Math.floor(Math.random() * u.leaseIds.length)];
  const liste = await requete('GET', `/api/v1/echeances?lease_id=${leaseId}&tri=due_date&limit=100`, { jeton: u.jeton });
  noter('encaissement espèces', liste, '/api/v1/echeances?lease_id');
  const e = (liste.body?.data?.items || []).find((x) => Number(x.amount_paid) < Number(x.amount_due) && !x.cancelled_at);
  if (!e) return;
  const r = await requete('POST', '/api/v1/paiements/especes', {
    jeton: u.jeton,
    entetes: { 'Idempotency-Key': crypto.randomUUID() },
    corps: { lease_id: leaseId, amount: Number(e.amount_due) - Number(e.amount_paid), paid_on: '2026-10-04', rent_schedule_id: e.id },
  });
  // 409 possible : deux utilisateurs virtuels du même compte encaissent la même échéance.
  noter('encaissement espèces', r, 'POST /paiements/especes');
}

const pause = (ms) => new Promise((ok) => { setTimeout(ok, ms); });

async function utilisateur(u, melange, fin) {
  await pause(Math.random() * 2000);
  while (Date.now() < fin) {
    const [, groupe, chemin] = tirer(melange);
    if (!chemin) await encaisser(u);
    else {
      const c = chemin(u);
      noter(groupe, await requete('GET', c, { jeton: u.jeton }), c);
    }
    if (REFLEXION_MS) await pause(REFLEXION_MS * (0.5 + Math.random()));
  }
}

const centile = (t, p) => t[Math.min(t.length - 1, Math.floor((p / 100) * t.length))];

function memoireServeur(pid) {
  if (PROCESSUS > 1) {
    // Cluster : somme des processus enfants (les workers), en Mo.
    try {
      const sortie = require('child_process').execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Measure-Object WorkingSetSize -Sum).Sum"`,
        { encoding: 'utf8' }
      );
      const o = Number(sortie.trim());
      return o ? Math.round(o / 1024 / 1024) : null;
    } catch { return null; }
  }
  try {
    const sortie = require('child_process').execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
    const ko = Number((sortie.split('","')[4] || '').replace(/[^\d]/g, ''));
    return ko ? Math.round(ko / 1024) : null;
  } catch { return null; }
}

async function main() {
  const fichier = path.resolve(__dirname, '..', '..', 'tmp', 'perf-comptes.json');
  if (!fs.existsSync(fichier)) throw new Error('Lancez d’abord scripts/perf/peupler.js');
  const { comptes } = JSON.parse(fs.readFileSync(fichier, 'utf8'));

  // Serveur réel, processus séparé. Variables vides = « non configuré » (dotenv
  // de server.js n'écrase pas une variable déjà définie, même vide).
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', JOBS_ENABLED: 'false', LOG_LEVEL: 'warn',
    REDIS_URL: '', R2_ACCOUNT_ID: '', RESEND_API_KEY: '', FIREBASE_SERVICE_ACCOUNT_JSON: '', WHATSAPP_ACCESS_TOKEN: '',
  };
  if (PROFIL) env.PROFIL_DUREE_S = String(DUREE_S + 5);
  env.CLUSTER_PROCESSUS = String(PROCESSUS);
  let script = 'src/server.js';
  if (PROFIL) script = 'scripts/perf/profil-serveur.js';
  else if (PROCESSUS > 1) script = 'scripts/perf/cluster-serveur.js';
  const serveur = spawn(process.execPath, [script], { cwd: path.resolve(__dirname, '..', '..'), env, stdio: ['pipe', 'ignore', 'pipe'] });
  const termine = new Promise((ok) => { serveur.on('exit', ok); });
  let stderr = '';
  serveur.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  try {
    await attendreServeur();
    const memoireDepart = memoireServeur(serveur.pid);

    const proprietaires = [];
    for (const c of comptes) {
      proprietaires.push({ ...c, jeton: await connecter(c.proprietaire.phone, c.proprietaire.password) });
    }
    const locataires = [];
    for (const c of comptes.slice(0, NB_LOCATAIRES)) {
      locataires.push({ ...c, jeton: await connecter(c.locataire.identifiant, c.locataire.password) });
    }

    process.stdout.write(`Charge : ${proprietaires.length * MULTIPLICATEUR} sessions propriétaires + ${locataires.length * MULTIPLICATEUR} locataires simultanées, ${DUREE_S} s, réflexion ${REFLEXION_MS} ms\n`);
    const debut = Date.now();
    mesureDes = debut + ECHAUFFEMENT_MS;
    const fin = mesureDes + DUREE_S * 1000;
    let memoireMax = memoireDepart || 0;
    const sonde = setInterval(() => { memoireMax = Math.max(memoireMax, memoireServeur(serveur.pid) || 0); }, 5000);
    const fois = (liste) => Array.from({ length: MULTIPLICATEUR }, () => liste).flat();
    await Promise.all([
      ...fois(proprietaires).map((u) => utilisateur(u, MELANGE_PROPRIETAIRE, fin)),
      ...fois(locataires).map((u) => utilisateur(u, MELANGE_LOCATAIRE, fin)),
    ]);
    clearInterval(sonde);
    const duree = (Date.now() - mesureDes) / 1000;

    const toutes = [...mesures.values()].flat().sort((a, b) => a - b);
    const lignes = [...mesures.entries()].sort((a, b) => b[1].length - a[1].length).map(([g, t]) => {
      t.sort((a, b) => a - b);
      return `  ${g.padEnd(22)} ${String(t.length).padStart(6)}  p50 ${centile(t, 50).toFixed(0).padStart(5)}  p95 ${centile(t, 95).toFixed(0).padStart(5)}  p99 ${centile(t, 99).toFixed(0).padStart(5)}  max ${t[t.length - 1].toFixed(0).padStart(5)} ms`;
    });
    const p95 = centile(toutes, 95);
    const rapport = {
      date: new Date().toISOString(), dureeS: duree, reflexionMs: REFLEXION_MS, processus: PROCESSUS,
      utilisateurs: { proprietaires: proprietaires.length * MULTIPLICATEUR, locataires: locataires.length * MULTIPLICATEUR },
      requetes: toutes.length, debit: toutes.length / duree,
      p50: centile(toutes, 50), p95, p99: centile(toutes, 99), max: toutes[toutes.length - 1],
      erreurs: erreurs.length, exemplesErreurs: erreurs.slice(0, 20), reponses4xx: attendues4xx,
      memoireServeurMo: { depart: memoireDepart, max: memoireMax },
      groupes: Object.fromEntries([...mesures.entries()].map(([g, t]) => [g, { n: t.length, p50: centile(t, 50), p95: centile(t, 95), p99: centile(t, 99) }])),
    };
    fs.writeFileSync(path.resolve(__dirname, '..', '..', 'tmp', `perf-charge-${REFLEXION_MS}ms-${PROCESSUS}p-x${MULTIPLICATEUR}.json`), JSON.stringify(rapport, null, 2));
    process.stdout.write([
      `Requêtes : ${toutes.length} en ${duree.toFixed(0)} s — ${rapport.debit.toFixed(0)} req/s`,
      `Latence globale : p50 ${rapport.p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, p99 ${rapport.p99.toFixed(0)} ms, max ${rapport.max.toFixed(0)} ms`,
      `Erreurs serveur / réseau : ${erreurs.length}   réponses 4xx : ${attendues4xx}`,
      `Mémoire du serveur : ${memoireDepart ?? '?'} Mo au départ, ${memoireMax || '?'} Mo au maximum`,
      'Par groupe d’écrans :', ...lignes,
      ...(erreurs.length ? ['Exemples d’erreurs :', ...erreurs.slice(0, 10).map((e) => `  ${e}`)] : []),
    ].join('\n'));
    process.stdout.write('\n');
    process.exitCode = erreurs.length || p95 > P95_MAX ? 1 : 0;
  } finally {
    // Profil : le serveur s'arrête seul après l'avoir écrit.
    if (PROFIL) await Promise.race([termine, pause(30000)]);
    serveur.stdin.end(); // cluster : le processus principal arrête ses workers
    await Promise.race([termine, pause(3000)]);
    serveur.kill();
    if (process.exitCode && stderr) process.stderr.write(`\nSortie d'erreur du serveur :\n${stderr}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`${e.stack}\n`);
  process.exit(2);
});
