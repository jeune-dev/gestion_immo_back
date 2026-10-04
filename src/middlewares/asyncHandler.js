'use strict';

/**
 * Enveloppe un handler Express async pour propager les rejets vers next(error).
 * Évite le try/catch boilerplate dans chaque contrôleur.
 *
 * Usage :
 *   exports.foo = asyncHandler(async (req, res) => { ... });
 *   static bar = asyncHandler(async (req, res) => { ... });
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
