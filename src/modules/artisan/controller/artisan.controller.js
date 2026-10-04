'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/artisan.service.js');

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { contractor: await S.detail(req.params.id, req.ownerId) }));
exports.creer = asyncHandler(async (req, res) => created(res, { contractor: await S.creer(req.ownerId, req.body) }, 'Artisan enregistré'));
exports.modifier = asyncHandler(async (req, res) => ok(res, { contractor: await S.modifier(req.params.id, req.ownerId, req.body) }, 'Artisan modifié'));
exports.desactiver = asyncHandler(async (req, res) => ok(res, { contractor: await S.definirActivite(req.params.id, req.ownerId, false) }, 'Artisan désactivé'));
exports.reactiver = asyncHandler(async (req, res) => ok(res, { contractor: await S.definirActivite(req.params.id, req.ownerId, true) }, 'Artisan réactivé'));

exports.supprimer = asyncHandler(async (req, res) => {
  await S.supprimer(req.params.id, req.ownerId);
  return ok(res, null, 'Artisan supprimé');
});
