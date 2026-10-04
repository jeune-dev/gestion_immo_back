'use strict';

/**
 * Erreurs métier de l'API (reprises de Widjila).
 * isOperational = true  → erreur attendue, message exposable au client
 * isOperational = false → bug, jamais exposé en production
 *
 * `code` : identifiant stable et non traduit, à l'usage des clients (mobile,
 * web) pour brancher un comportement sans analyser le texte du message.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true, code = null, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    if (details !== null && details !== undefined) this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Requête invalide', code = null, details = null) { super(message, 400, true, code, details); }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Non authentifié', code = null) { super(message, 401, true, code); }
}

class PaymentRequiredError extends AppError {
  constructor(message = 'Abonnement requis', code = 'ABONNEMENT_REQUIS', details = null) { super(message, 402, true, code, details); }
}

class ForbiddenError extends AppError {
  constructor(message = 'Accès refusé', code = null, details = null) { super(message, 403, true, code, details); }
}

class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable', code = null) { super(message, 404, true, code); }
}

class ConflictError extends AppError {
  constructor(message = 'Conflit avec l’état actuel de la ressource', code = null, details = null) { super(message, 409, true, code, details); }
}

/** Erreur de validation — porte la liste des messages Joi. */
class ValidationError extends AppError {
  constructor(message = 'Données invalides', details = [], code = null) { super(message, 422, true, code, details); }
}

/** Dépendance externe indisponible (base, fournisseur de paiement, stockage…). */
class ServiceIndisponibleError extends AppError {
  constructor(message = 'Service temporairement indisponible', code = 'SERVICE_INDISPONIBLE', details = null) {
    super(message, 503, true, code, details);
  }
}

module.exports = {
  AppError,
  BadRequestError,
  UnauthorizedError,
  PaymentRequiredError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  ServiceIndisponibleError,
};
