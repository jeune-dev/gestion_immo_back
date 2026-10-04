'use strict';

const { monitorEventLoopDelay } = require('node:perf_hooks');
const logger = require('./logger.js');

/**
 * Métriques applicatives, en mémoire, PAR PROCESS.
 *
 * Il n'en existait aucune : volume de requêtes, taux d'erreur, latences,
 * échecs des services externes, échecs des tâches planifiées — rien ne se
 * mesurait. Une panne partielle (le fournisseur d'e-mail qui ne répond plus,
 * un job qui échoue chaque nuit) ne se découvrait que par un utilisateur.
 *
 * Exposées par `GET /metrics` (JSON, ou texte Prometheus avec
 * `?format=prometheus`), protégé par `METRICS_TOKEN` en production.
 *
 * Limites assumées :
 *   - en cluster PM2, chaque worker a SES compteurs : la vue globale se fait
 *     côté collecteur (somme des workers), pas ici ;
 *   - les centiles sont lus sur des tranches fixes : la valeur rendue est la
 *     borne HAUTE de la tranche (approximation par excès, jamais par défaut —
 *     une alerte de latence ne sera pas manquée à cause de l'arrondi) ;
 *   - remise à zéro au redémarrage du process.
 */

const BORNES_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

/** Au-delà, une route nouvelle est comptée dans « AUTRES » : pas d'explosion mémoire. */
const MAX_ROUTES = 300;

/** Au-delà de ce délai, une requête est journalisée comme lente (avec son requestId). */
const SEUIL_REQUETE_LENTE_MS = parseInt(process.env.SEUIL_REQUETE_LENTE_MS || '3000', 10);

class Histogramme {
  constructor() {
    this.tranches = new Array(BORNES_MS.length + 1).fill(0);
    this.total = 0;
    this.sommeMs = 0;
    this.maxMs = 0;
  }

  observer(ms) {
    let i = 0;
    while (i < BORNES_MS.length && ms > BORNES_MS[i]) i += 1;
    this.tranches[i] += 1;
    this.total += 1;
    this.sommeMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  /** Centile `p` (0–1) : borne haute de la tranche qui le contient, plafonnée au maximum observé. */
  centile(p) {
    if (this.total === 0) return null;
    const rang = Math.ceil(p * this.total);
    let cumul = 0;
    for (let i = 0; i < this.tranches.length; i += 1) {
      cumul += this.tranches[i];
      if (cumul >= rang) return i < BORNES_MS.length ? Math.min(BORNES_MS[i], this.maxMs) : this.maxMs;
    }
    return this.maxMs;
  }

  resume() {
    return {
      total: this.total,
      moyenneMs: this.total ? Math.round(this.sommeMs / this.total) : null,
      p50Ms: this.centile(0.5),
      p95Ms: this.centile(0.95),
      p99Ms: this.centile(0.99),
      maxMs: this.total ? Math.round(this.maxMs) : null,
    };
  }
}

let etat;
let boucle = null;

function reinitialiser() {
  etat = {
    demarreLe: Date.now(),
    requetes: {
      total: 0,
      enCours: 0,
      interrompues: 0,
      parClasse: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
      latence: new Histogramme(),
    },
    routes: new Map(),
    erreurs: new Map(),
    compteurs: new Map(),
    dependances: new Map(),
    jobs: new Map(),
  };
}
reinitialiser();

/** Sondes instantanées (pool DB…) enregistrées par les modules qui détiennent l'information. */
const sondes = new Map();

function surveillerBoucle() {
  if (!boucle) {
    boucle = monitorEventLoopDelay({ resolution: 20 });
    boucle.enable();
  }
  return boucle;
}

// ── Requêtes HTTP ───────────────────────────────────────────────────────────

const MOTIF_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SEGMENT_NUMERIQUE = /\/\d+(?=\/|$)/g;
// Jeton opaque (lien de partage, identifiant aléatoire) : 20 caractères et plus.
const SEGMENT_JETON = /\/[A-Za-z0-9_-]{20,}(?=\/|$)/g;

/**
 * Clé de regroupement d'une requête : méthode + chemin NORMALISÉ (identifiants
 * remplacés par `:id`, `:n`, `:jeton`).
 *
 * Pas le motif Express (`req.baseUrl + req.route.path`) : quand une erreur
 * sort d'un routeur, Express a déjà RESTAURÉ `baseUrl` au moment de la
 * réponse — la clé perdait son préfixe (`GET /:id` pour dix routes
 * différentes). Le chemin réel, lui, est toujours juste.
 */
function cleRoute(req, statut) {
  const chemin = String(req.originalUrl || req.url || '').split('?')[0];
  // Fichiers servis : un nom unique par fichier exploserait la cardinalité.
  if (/^(\/api\/v1)?\/uploads\//.test(chemin)) return `${req.method} /uploads/*`;
  // Route inconnue : les robots qui sondent des URL au hasard ne créent pas
  // une série par URL.
  if (statut === 404 && !req.route) return 'NON_ROUTEE';
  const normalise = chemin
    .replace(MOTIF_UUID, ':id')
    .replace(SEGMENT_NUMERIQUE, '/:n')
    .replace(SEGMENT_JETON, '/:jeton');
  return `${req.method} ${normalise || '/'}`;
}

function observerRequete({ cle, statut, dureeMs }) {
  const r = etat.requetes;
  r.total += 1;
  const classe = `${Math.floor(statut / 100)}xx`;
  if (classe in r.parClasse) r.parClasse[classe] += 1;
  r.latence.observer(dureeMs);

  let route = etat.routes.get(cle);
  if (!route) {
    if (etat.routes.size >= MAX_ROUTES) {
      cle = 'AUTRES';
      route = etat.routes.get(cle);
    }
    if (!route) {
      route = { total: 0, erreurs4xx: 0, erreurs5xx: 0, latence: new Histogramme() };
      etat.routes.set(cle, route);
    }
  }
  route.total += 1;
  if (statut >= 500) route.erreurs5xx += 1;
  else if (statut >= 400) route.erreurs4xx += 1;
  route.latence.observer(dureeMs);
}

/**
 * Middleware de mesure — synchrone : il n'ajoute qu'un horodatage et deux
 * écouteurs. La mesure se fait à `finish` ; une requête dont le client a
 * coupé la connexion avant la réponse est comptée à part (`interrompues`).
 */
function mesurerRequetes(req, res, next) {
  const debut = process.hrtime.bigint();
  etat.requetes.enCours += 1;
  let termine = false;

  const conclure = (interrompue) => {
    if (termine) return;
    termine = true;
    etat.requetes.enCours -= 1;
    const dureeMs = Number(process.hrtime.bigint() - debut) / 1e6;
    if (interrompue) {
      etat.requetes.interrompues += 1;
      return;
    }
    const cle = cleRoute(req, res.statusCode);
    observerRequete({ cle, statut: res.statusCode, dureeMs });
    if (dureeMs >= SEUIL_REQUETE_LENTE_MS) {
      logger.warn(`[perf] Requête lente : ${cle} — ${Math.round(dureeMs)} ms`, {
        requestId: req.id,
        route: cle,
        statut: res.statusCode,
        dureeMs: Math.round(dureeMs),
        utilisateurId: req.user?.id,
      });
    }
  };

  res.on('finish', () => conclure(false));
  res.on('close', () => conclure(!res.writableFinished));
  next();
}

// ── Erreurs, compteurs ──────────────────────────────────────────────────────

function enregistrerErreur(code) {
  etat.erreurs.set(code, (etat.erreurs.get(code) || 0) + 1);
}

function incrementer(nom, n = 1) {
  etat.compteurs.set(nom, (etat.compteurs.get(nom) || 0) + n);
}

// ── Dépendances externes (e-mail, push, stockage…) ──────────────────────────

function dependance(nom) {
  let d = etat.dependances.get(nom);
  if (!d) {
    d = {
      appels: 0,
      echecs: 0,
      rejetsCircuit: 0,
      circuit: 'ferme',
      latence: new Histogramme(),
      dernierSucces: null,
      dernierEchec: null,
    };
    etat.dependances.set(nom, d);
  }
  return d;
}

function enregistrerAppelDependance(nom, { succes, dureeMs, erreur }) {
  const d = dependance(nom);
  d.appels += 1;
  if (dureeMs !== undefined) d.latence.observer(dureeMs);
  if (succes) {
    d.dernierSucces = new Date().toISOString();
  } else {
    d.echecs += 1;
    d.dernierEchec = { le: new Date().toISOString(), message: String(erreur?.message || erreur || '').slice(0, 300) };
  }
}

function enregistrerRejetCircuit(nom) {
  dependance(nom).rejetsCircuit += 1;
}

function enregistrerEtatCircuit(nom, etatCircuit) {
  dependance(nom).circuit = etatCircuit;
}

// ── Tâches planifiées ───────────────────────────────────────────────────────

function job(nom) {
  let j = etat.jobs.get(nom);
  if (!j) {
    j = {
      executions: 0,
      echecs: 0,
      ignores: 0,
      enCours: false,
      derniereDureeMs: null,
      dernierSucces: null,
      dernierEchec: null,
    };
    etat.jobs.set(nom, j);
  }
  return j;
}

function jobDemarre(nom) {
  job(nom).enCours = true;
}

function jobTermine(nom, { succes, dureeMs, erreur }) {
  const j = job(nom);
  j.enCours = false;
  j.executions += 1;
  j.derniereDureeMs = Math.round(dureeMs);
  if (succes) {
    j.dernierSucces = new Date().toISOString();
  } else {
    j.echecs += 1;
    j.dernierEchec = { le: new Date().toISOString(), message: String(erreur?.message || erreur || '').slice(0, 300) };
  }
}

function jobIgnore(nom) {
  job(nom).ignores += 1;
}

// ── Sondes & lecture ────────────────────────────────────────────────────────

function enregistrerSonde(nom, fn) {
  sondes.set(nom, fn);
}

function lireSondes() {
  const resultat = {};
  for (const [nom, fn] of sondes) {
    try {
      resultat[nom] = fn();
    } catch (err) {
      resultat[nom] = { erreur: err.message };
    }
  }
  return resultat;
}

function versObjet(map, transformer = (v) => v) {
  const o = {};
  for (const [cle, valeur] of map) o[cle] = transformer(valeur);
  return o;
}

function instantane() {
  const r = etat.requetes;
  const eld = surveillerBoucle();
  const memoire = process.memoryUsage();
  const erreursServeur = r.parClasse['5xx'];

  return {
    genereLe: new Date().toISOString(),
    process: {
      pid: process.pid,
      instance: process.env.NODE_APP_INSTANCE ?? null,
      uptimeS: Math.round(process.uptime()),
      memoire: {
        rssMo: Math.round(memoire.rss / 1048576),
        heapUtiliseMo: Math.round(memoire.heapUsed / 1048576),
        heapTotalMo: Math.round(memoire.heapTotal / 1048576),
      },
      cpu: process.cpuUsage(),
      boucleEvenements: {
        p50Ms: Math.round(eld.percentile(50) / 1e6),
        p99Ms: Math.round(eld.percentile(99) / 1e6),
        maxMs: Math.round(eld.max / 1e6),
      },
    },
    requetes: {
      total: r.total,
      enCours: r.enCours,
      interrompues: r.interrompues,
      parClasse: { ...r.parClasse },
      tauxErreurServeur: r.total ? Number((erreursServeur / r.total).toFixed(4)) : 0,
      latence: r.latence.resume(),
    },
    routes: versObjet(etat.routes, (v) => ({
      total: v.total,
      erreurs4xx: v.erreurs4xx,
      erreurs5xx: v.erreurs5xx,
      latence: v.latence.resume(),
    })),
    erreurs: versObjet(etat.erreurs),
    compteurs: versObjet(etat.compteurs),
    dependances: versObjet(etat.dependances, (v) => ({
      appels: v.appels,
      echecs: v.echecs,
      rejetsCircuit: v.rejetsCircuit,
      circuit: v.circuit,
      latence: v.latence.resume(),
      dernierSucces: v.dernierSucces,
      dernierEchec: v.dernierEchec,
    })),
    jobs: versObjet(etat.jobs, (v) => ({ ...v })),
    sondes: lireSondes(),
  };
}

// ── Format texte Prometheus ─────────────────────────────────────────────────

const etiquette = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');

function formatPrometheus() {
  const s = instantane();
  const lignes = [];
  const serie = (nom, type, aide, valeurs) => {
    lignes.push(`# HELP ${nom} ${aide}`, `# TYPE ${nom} ${type}`);
    for (const [labels, valeur] of valeurs) {
      if (valeur === null || valeur === undefined || Number.isNaN(valeur)) continue;
      const texteLabels = Object.entries(labels).map(([k, v]) => `${k}="${etiquette(v)}"`).join(',');
      lignes.push(`${nom}${texteLabels ? `{${texteLabels}}` : ''} ${valeur}`);
    }
  };

  serie('http_requetes_total', 'counter', 'Requêtes HTTP terminées, par classe de statut',
    Object.entries(s.requetes.parClasse).map(([classe, n]) => [{ classe }, n]));
  serie('http_requetes_en_cours', 'gauge', 'Requêtes HTTP en cours', [[{}, s.requetes.enCours]]);
  serie('http_requetes_interrompues_total', 'counter', 'Requêtes coupées par le client avant la réponse',
    [[{}, s.requetes.interrompues]]);

  const latence = etat.requetes.latence;
  lignes.push('# HELP http_requete_duree_ms Durée des requêtes HTTP', '# TYPE http_requete_duree_ms histogram');
  let cumul = 0;
  BORNES_MS.forEach((borne, i) => {
    cumul += latence.tranches[i];
    lignes.push(`http_requete_duree_ms_bucket{le="${borne}"} ${cumul}`);
  });
  lignes.push(`http_requete_duree_ms_bucket{le="+Inf"} ${latence.total}`);
  lignes.push(`http_requete_duree_ms_sum ${Math.round(latence.sommeMs)}`);
  lignes.push(`http_requete_duree_ms_count ${latence.total}`);

  serie('http_route_requetes_total', 'counter', 'Requêtes par route',
    Object.entries(s.routes).map(([route, v]) => [{ route }, v.total]));
  serie('http_route_erreurs_5xx_total', 'counter', 'Erreurs serveur par route',
    Object.entries(s.routes).map(([route, v]) => [{ route }, v.erreurs5xx]));
  serie('http_route_duree_p95_ms', 'gauge', 'P95 de latence par route (approché par tranche)',
    Object.entries(s.routes).map(([route, v]) => [{ route }, v.latence.p95Ms]));
  serie('api_erreurs_total', 'counter', 'Erreurs renvoyées, par code',
    Object.entries(s.erreurs).map(([code, n]) => [{ code }, n]));
  serie('app_evenements_total', 'counter', 'Compteurs applicatifs divers',
    Object.entries(s.compteurs).map(([nom, n]) => [{ nom }, n]));

  serie('dependance_appels_total', 'counter', 'Appels aux services externes',
    Object.entries(s.dependances).map(([dependance, v]) => [{ dependance }, v.appels]));
  serie('dependance_echecs_total', 'counter', 'Échecs des services externes',
    Object.entries(s.dependances).map(([dependance, v]) => [{ dependance }, v.echecs]));
  serie('dependance_rejets_circuit_total', 'counter', 'Appels refusés circuit ouvert',
    Object.entries(s.dependances).map(([dependance, v]) => [{ dependance }, v.rejetsCircuit]));
  serie('dependance_circuit_ouvert', 'gauge', '1 si le disjoncteur est ouvert ou demi-ouvert',
    Object.entries(s.dependances).map(([dependance, v]) => [{ dependance }, v.circuit === 'ferme' ? 0 : 1]));

  serie('job_executions_total', 'counter', 'Exécutions des tâches planifiées',
    Object.entries(s.jobs).map(([nom, v]) => [{ job: nom }, v.executions]));
  serie('job_echecs_total', 'counter', 'Échecs des tâches planifiées',
    Object.entries(s.jobs).map(([nom, v]) => [{ job: nom }, v.echecs]));
  serie('job_dernier_succes_timestamp_s', 'gauge', 'Horodatage du dernier succès',
    Object.entries(s.jobs).map(([nom, v]) => [{ job: nom }, v.dernierSucces ? Math.round(Date.parse(v.dernierSucces) / 1000) : null]));

  serie('process_rss_octets', 'gauge', 'Mémoire résidente', [[{}, process.memoryUsage().rss]]);
  serie('process_heap_utilise_octets', 'gauge', 'Tas V8 utilisé', [[{}, process.memoryUsage().heapUsed]]);
  serie('nodejs_boucle_retard_p99_ms', 'gauge', 'Retard de la boucle d’événements (P99)',
    [[{}, s.process.boucleEvenements.p99Ms]]);
  serie('process_uptime_s', 'gauge', 'Durée de vie du process', [[{}, s.process.uptimeS]]);

  const pool = s.sondes.pool_db;
  if (pool && !pool.erreur) {
    serie('db_pool_connexions', 'gauge', 'Connexions du pool PostgreSQL', [
      [{ etat: 'utilisees' }, pool.utilisees],
      [{ etat: 'disponibles' }, pool.disponibles],
      [{ etat: 'total' }, pool.taille],
    ]);
    serie('db_pool_en_attente', 'gauge', 'Requêtes en attente d’une connexion', [[{}, pool.enAttente]]);
  }

  return `${lignes.join('\n')}\n`;
}

module.exports = {
  Histogramme,
  BORNES_MS,
  mesurerRequetes,
  observerRequete,
  enregistrerErreur,
  incrementer,
  enregistrerAppelDependance,
  enregistrerRejetCircuit,
  enregistrerEtatCircuit,
  jobDemarre,
  jobTermine,
  jobIgnore,
  enregistrerSonde,
  instantane,
  formatPrometheus,
  reinitialiser,
};
