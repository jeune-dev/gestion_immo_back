'use strict';

const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const { corsConfig, rateLimitConfig, isProd } = require('./config/security.js');
const sequelize = require('./config/db.js');
const redisClient = require('./config/redis.js');
const logger = require('./utils/logger.js');
const masquerUrl = require('./utils/masquerUrl.js');
const metrics = require('./utils/metrics.js');
const etatApplication = require('./utils/etatApplication.js');
const { avecDelai } = require('./utils/circuitBreaker.js');
const storage = require('./infrastructure/storage.service.js');
const requestId = require('./middlewares/requestId.middleware.js');
const errorHandler = require('./middlewares/errorHandler.middleware.js');
const { journaliserDepassement } = require('./middlewares/rateLimit.middleware.js');

storage.ensureUploadDir();

const app = express();

// Derrière nginx sur le même hôte : un seul proxy de confiance (lecture
// correcte de X-Forwarded-For par le limiteur de débit).
app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS || '1', 10));
app.disable('x-powered-by');

// ── Corrélation et mesure — EN PREMIER (repris de Widjila) ─────────────────
app.use(requestId);
app.use(metrics.mesurerRequetes);
metrics.enregistrerSonde('pool_db', () => {
  const pool = sequelize.connectionManager?.pool;
  if (!pool || typeof pool.size !== 'number') return null;
  return { taille: pool.size, disponibles: pool.available, utilisees: pool.using, enAttente: pool.waiting, max: pool.maxSize ?? null };
});

// ── En-têtes de sécurité ───────────────────────────────────────────────────
// L'API ne sert que du JSON et des fichiers : CSP la plus stricte possible.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});
app.use(cors(corsConfig));
app.use(cookieParser());

// ── Journal d'accès (URL masquée : jetons d'activation, codes) ─────────────
morgan.token('url-masquee', (req) => masquerUrl(req.originalUrl || req.url));
morgan.token('request-id', (req) => req.id || '-');
morgan.token('utilisateur', (req) => req.user?.id || '-');
const FORMAT_JOURNAL = isProd
  ? ':remote-addr - :utilisateur ":method :url-masquee HTTP/:http-version" :status :res[content-length] :response-time ms ":user-agent" rid=:request-id'
  : ':method :url-masquee :status :response-time ms - :res[content-length] rid=:request-id';
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(FORMAT_JOURNAL, { stream: { write: (msg) => logger.info(msg.trim()) } }));
}

// ── Corps de requête ───────────────────────────────────────────────────────
// Les webhooks (Wave, WhatsApp) sont signés sur les octets BRUTS : ils sont
// capturés pendant la lecture (`verify`), seul moment où ils existent encore
// (cause du bug de signature documenté dans Widjila).
const capturerCorpsBrut = (req, res, buf) => {
  if (buf?.length && (req.originalUrl || '').startsWith('/api/v1/webhooks/')) req.rawBody = Buffer.from(buf);
};
app.use(express.json({ limit: '256kb', verify: capturerCorpsBrut }));
// extended:false → pas d'objets imbriqués (pas de pollution de prototype).
app.use(express.urlencoded({ extended: false, limit: '64kb', verify: capturerCorpsBrut }));

// ── Filet global anti-scan (par IP) ────────────────────────────────────────
// Les webhooks en sont EXCLUS : PayDunya envoie toutes ses IPN depuis les mêmes
// serveurs — le filet par IP bloquerait les confirmations de paiement de TOUS
// les propriétaires dès 1 000 notifications / 15 min. Ils ont leur propre
// limite (routes.js : webhookRateLimit) et sont authentifiés (signature ou relecture).
const PREFIXE_WEBHOOKS = '/api/v1/webhooks/';
const horsLimiteGlobale = (req) => (req.originalUrl || req.url || '').startsWith(PREFIXE_WEBHOOKS);
app.use(rateLimit({ ...rateLimitConfig, skip: horsLimiteGlobale, handler: journaliserDepassement('global') }));

// ── Sondes de santé (hors versioning) ──────────────────────────────────────
//   /health/live  : le process répond (sonde de redémarrage, sans dépendance)
//   /health/ready : base et stockage joignables (sonde de disponibilité)
//   /health       : alias de /health/ready (Dockerfile, nginx)
const DELAI_SONDE_MS = 3000;
let bilanSante = null;
let bilanSanteLe = 0;
let bilanEnCours = null;

async function evaluerSante() {
  const [db, stockage] = await Promise.allSettled([
    avecDelai(sequelize.authenticate(), DELAI_SONDE_MS, 'de base de données'),
    avecDelai(storage.ping(), DELAI_SONDE_MS, 'de stockage'),
  ]);
  const dbOk = db.status === 'fulfilled';
  const st = stockage.status === 'fulfilled' ? stockage.value : { configure: null, joignable: false };
  const redisOk = !redisClient || redisClient.status === 'ready';
  return {
    dbOk,
    corps: {
      status: dbOk && st.joignable !== false && redisOk ? 'ok' : 'degraded',
      db: dbOk ? 'connected' : 'disconnected',
      storage: st.configure === false ? 'disque local' : (st.joignable ? 'connected' : 'disconnected'),
      redis: redisClient ? redisClient.status : 'non configuré',
      uptime: Math.round(process.uptime()),
      timestamp: Date.now(),
    },
  };
}

function santeEnCache() {
  if (bilanSante && Date.now() - bilanSanteLe < 5000) return Promise.resolve(bilanSante);
  if (!bilanEnCours) {
    bilanEnCours = evaluerSante()
      .then((b) => { bilanSante = b; bilanSanteLe = Date.now(); return b; })
      .finally(() => { bilanEnCours = null; });
  }
  return bilanEnCours;
}

app.get('/health/live', (req, res) => res.json({ status: 'ok', uptime: Math.round(process.uptime()) }));
const sondeDisponibilite = async (req, res) => {
  const { dbOk, corps } = await santeEnCache();
  const enArret = etatApplication.estEnArret();
  res.setHeader('Cache-Control', 'no-store');
  res.status(dbOk && !enArret ? 200 : 503).json(enArret ? { ...corps, status: 'arret en cours' } : corps);
};
app.get('/health', sondeDisponibilite);
app.get('/health/ready', sondeDisponibilite);

// ── Métriques : uniquement avec METRICS_TOKEN (jamais publiques en production)
app.get('/metrics', (req, res) => {
  const jeton = process.env.METRICS_TOKEN;
  if (!jeton) return res.status(404).json({ success: false, message: 'Ressource introuvable', requestId: req.id });
  const fourni = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const attendu = Buffer.from(jeton);
  if (fourni.length !== attendu.length || !crypto.timingSafeEqual(fourni, attendu)) {
    return res.status(401).json({ success: false, message: 'Non authentifié', error: { code: 'NON_AUTHENTIFIE', message: 'Non authentifié' }, requestId: req.id });
  }
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.format === 'prometheus') return res.type('text/plain; version=0.0.4').send(metrics.formatPrometheus());
  return res.json(metrics.instantane());
});

// ── Routes métier ──────────────────────────────────────────────────────────
// Pattern (Widjila) : route → controller → service → model, sous /api/v1.
app.use('/api/v1', require('./routes.js'));

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ressource introuvable',
    error: { code: 'ROUTE_INTROUVABLE', message: 'Ressource introuvable' },
    requestId: req.id,
  });
});

app.use(errorHandler);

module.exports = app;
module.exports.horsLimiteGlobale = horsLimiteGlobale;
