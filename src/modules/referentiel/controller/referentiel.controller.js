'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok } = require('../../../utils/response.js');
const ReferentielService = require('../service/referentiel.service.js');

/**
 * Cache HTTP public d'une heure : les énumérations ne changent qu'avec un
 * déploiement ; le mobile et les proxys évitent ainsi un aller-retour à chaque
 * ouverture de l'application.
 */
exports.lister = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  return ok(res, ReferentielService.tous());
});
