'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const ImmeubleService = require('../service/immeuble.service.js');

exports.lister = asyncHandler(async (req, res) =>
  paginated(res, await ImmeubleService.lister(req.ownerId, req.query, req.pagination), req.pagination));

exports.detail = asyncHandler(async (req, res) =>
  ok(res, { building: await ImmeubleService.detail(req.params.id, req.ownerId) }));

exports.creer = asyncHandler(async (req, res) =>
  created(res, { building: await ImmeubleService.creer(req.ownerId, req.body) }, 'Immeuble créé'));

exports.modifier = asyncHandler(async (req, res) =>
  ok(res, { building: await ImmeubleService.modifier(req.params.id, req.ownerId, req.body) }, 'Immeuble modifié'));

exports.supprimer = asyncHandler(async (req, res) => {
  await ImmeubleService.supprimer(req.params.id, req.ownerId);
  return ok(res, null, 'Immeuble supprimé');
});
