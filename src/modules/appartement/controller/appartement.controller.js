'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/appartement.service.js');

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { apartment: await S.detail(req.params.id, req.ownerId) }));
exports.creer = asyncHandler(async (req, res) => created(res, { apartment: await S.creer(req.ownerId, req.body) }, 'Appartement créé'));
exports.modifier = asyncHandler(async (req, res) => ok(res, { apartment: await S.modifier(req.params.id, req.ownerId, req.body) }, 'Appartement modifié'));
exports.changerStatut = asyncHandler(async (req, res) => ok(res, { apartment: await S.changerStatut(req.params.id, req.ownerId, req.body) }, 'Statut modifié'));
exports.supprimer = asyncHandler(async (req, res) => {
  await S.supprimer(req.params.id, req.ownerId);
  return ok(res, null, 'Appartement supprimé');
});
exports.historique = asyncHandler(async (req, res) => paginated(res, await S.historique(req.params.id, req.ownerId, req.query, req.pagination), req.pagination));
exports.rentabilite = asyncHandler(async (req, res) => ok(res, { rentabilite: await S.rentabilite(req.params.id, req.ownerId, req.query) }));
