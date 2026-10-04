'use strict';

const { ConnectionError: SequelizeConnectionError } = require('sequelize');
const { AppError } = require('../errors/AppError.js');
const metrics = require('../utils/metrics.js');
const { signalerErreurServeur } = require('../infrastructure/alertes.service.js');
const logger = require('../utils/logger.js');
const masquerUrl = require('../utils/masquerUrl.js');

const isProd = process.env.NODE_ENV === 'production';

/**
 * Gestionnaire d'erreurs centralisé (repris de Widjila). Monté EN DERNIER.
 *
 * Réponse :
 *   { success: false, message, code?, details?, error: { code, message, details? }, requestId }
 *
 * Aucun détail interne (pile, requête SQL, nom de contrainte, chemin) ne part
 * au client en production. Tout est journalisé côté serveur avec l'identifiant
 * de requête, l'utilisateur et l'espace propriétaire.
 */

const CODE_PAR_STATUT = {
  400: 'REQUETE_INVALIDE',
  401: 'NON_AUTHENTIFIE',
  402: 'ABONNEMENT_REQUIS',
  403: 'ACCES_REFUSE',
  404: 'RESSOURCE_INTROUVABLE',
  409: 'CONFLIT',
  413: 'CONTENU_TROP_VOLUMINEUX',
  422: 'DONNEES_INVALIDES',
  429: 'TROP_DE_REQUETES',
  503: 'SERVICE_INDISPONIBLE',
};

/** Codes PostgreSQL d'une base injoignable ou saturée (et non d'une requête fautive). */
const CODES_PG_INDISPONIBLE = /^(57014|57P0[123]|53300|08\w{3}|40001|40P01)$/;

function estBaseIndisponible(err) {
  if (err instanceof SequelizeConnectionError) return true;
  if (typeof err.name === 'string' && /^Sequelize(Connection\w*|HostNot\w*|AccessDenied|InvalidConnection|Timeout)Error$/.test(err.name)) {
    return true;
  }
  const codePg = err.parent?.code || err.original?.code;
  return typeof codePg === 'string' && CODES_PG_INDISPONIBLE.test(codePg);
}

/** Traduit n'importe quelle erreur en réponse normalisée. */
function normaliser(err) {
  if (err instanceof AppError && err.isOperational) {
    const statut = err.statusCode;
    return {
      statut,
      code: err.code || CODE_PAR_STATUT[statut] || 'ERREUR',
      codeExplicite: Boolean(err.code),
      message: err.message,
      details: err.details,
      retryAfterS: statut === 503 ? (err.details?.reessayerDansS || 5) : null,
    };
  }

  if (err.name === 'TokenExpiredError') return { statut: 401, code: 'TOKEN_EXPIRE', message: 'Session expirée' };
  if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
    return { statut: 401, code: 'TOKEN_INVALIDE', message: 'Jeton invalide' };
  }

  if (err.name === 'MulterError') {
    const tropGros = err.code === 'LIMIT_FILE_SIZE';
    return {
      statut: tropGros ? 413 : 400,
      code: tropGros ? 'FICHIER_TROP_VOLUMINEUX' : 'ENVOI_FICHIER_INVALIDE',
      message: tropGros ? 'Fichier trop volumineux' : "Erreur lors de l'envoi du fichier",
    };
  }

  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return { statut: 400, code: 'JSON_INVALIDE', message: 'Corps de requête JSON invalide' };
  }
  if (err.status === 413 || err.type === 'entity.too.large') {
    return { statut: 413, code: 'CONTENU_TROP_VOLUMINEUX', message: 'Corps de la requête trop volumineux' };
  }

  if (err.name === 'SequelizeValidationError') {
    return {
      statut: 422,
      code: 'DONNEES_INVALIDES',
      message: 'Données invalides',
      details: isProd ? undefined : err.errors?.map((e) => e.message),
    };
  }
  if (err.name === 'SequelizeUniqueConstraintError') {
    return { statut: 409, code: 'RESSOURCE_EXISTANTE', message: 'Cette ressource existe déjà' };
  }
  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return { statut: 400, code: 'REFERENCE_INVALIDE', message: 'Référence invalide : ressource liée introuvable' };
  }
  // Violation d'un CHECK SQL : la base a refusé une incohérence que la
  // validation applicative aurait dû intercepter. C'est une donnée refusée, pas
  // une panne — mais le nom de la contrainte ne part jamais au client.
  if (err.name === 'SequelizeDatabaseError' && err.parent?.code === '23514') {
    return { statut: 422, code: 'DONNEES_INCOHERENTES', message: 'Opération refusée : données incohérentes' };
  }
  // Identifiant malformé (UUID invalide) : ressource qui ne peut pas exister.
  if (err.name === 'SequelizeDatabaseError' && err.parent?.code === '22P02') {
    return { statut: 404, code: 'RESSOURCE_INTROUVABLE', message: 'Ressource introuvable' };
  }

  if (estBaseIndisponible(err)) {
    return { statut: 503, code: 'BASE_INDISPONIBLE', message: 'Service temporairement indisponible', retryAfterS: 5 };
  }

  return {
    statut: 500,
    code: 'ERREUR_INTERNE',
    message: isProd ? 'Erreur interne du serveur' : (err.message || 'Erreur interne du serveur'),
  };
}

/** 5xx → error (avec pile), refus de droits → warn, erreurs client → info. */
function niveau(statut) {
  if (statut >= 500) return 'error';
  if (statut === 403 || statut === 413 || statut === 429) return 'warn';
  return 'info';
}

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const erreur = normaliser(err);
  const requestId = req.id;

  const contexte = {
    requestId,
    statut: erreur.statut,
    code: erreur.code,
    methode: req.method,
    motifRoute: req.route?.path,
    chemin: masquerUrl(req.originalUrl || req.path),
    utilisateurId: req.user?.id,
    ownerId: req.ownerId,
    ip: req.ip,
    erreur: err.name,
  };
  if (erreur.statut >= 500) {
    contexte.stack = err.stack;
    const cause = err.parent || err.original;
    if (cause) contexte.causeSql = { code: cause.code, message: cause.message, contrainte: cause.constraint };
  }
  // JSON mal formé : le message de JSON.parse RECOPIE un extrait du corps
  // (« …"password":Secret123} is not valid JSON ») — jamais journalisé tel quel.
  const corpsIllisible = err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err);
  if (corpsIllisible) contexte.typeErreur = err.type || 'SyntaxError';
  logger.log(niveau(erreur.statut), corpsIllisible ? erreur.message : (err.message || erreur.message), contexte);
  // Compteur par code d'erreur (série api_erreurs_total, jusqu'ici jamais
  // alimentée) et alerte sur rafale d'erreurs serveur (constat M9).
  metrics.enregistrerErreur(erreur.code);
  if (erreur.statut >= 500) signalerErreurServeur({ code: erreur.code });

  if (res.headersSent) return next(err);

  const corps = { success: false, message: erreur.message };
  if (Array.isArray(erreur.details) && erreur.details.length) corps.details = erreur.details;
  if (erreur.codeExplicite) corps.code = erreur.code;
  corps.error = {
    code: erreur.code,
    message: erreur.message,
    ...(erreur.details !== undefined && erreur.details !== null ? { details: erreur.details } : {}),
  };
  if (requestId) corps.requestId = requestId;

  if (erreur.retryAfterS) res.setHeader('Retry-After', String(erreur.retryAfterS));
  return res.status(erreur.statut).json(corps);
};

module.exports = errorHandler;
module.exports.normaliser = normaliser;
module.exports.estBaseIndisponible = estBaseIndisponible;
