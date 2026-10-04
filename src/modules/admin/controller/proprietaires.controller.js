'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, paginated } = require('../../../utils/response.js');
const S = require('../service/proprietaires.service.js');

exports.lister = asyncHandler(async (req, res) =>
  paginated(res, await S.listerProprietaires(req.query, req.pagination), req.pagination));

exports.detail = asyncHandler(async (req, res) => ok(res, { owner: await S.detailProprietaire(req.params.id) }));

exports.suspendre = asyncHandler(async (req, res) =>
  ok(res, { owner: await S.suspendre(req.params.id, req.body) }, 'Espace propriétaire suspendu'));

exports.reactiver = asyncHandler(async (req, res) =>
  ok(res, { owner: await S.reactiver(req.params.id) }, 'Espace propriétaire réactivé'));

exports.locataires = asyncHandler(async (req, res) =>
  paginated(res, await S.listerLocataires(req.query, req.pagination), req.pagination));

exports.immeubles = asyncHandler(async (req, res) =>
  paginated(res, await S.listerImmeubles(req.query, req.pagination), req.pagination));

exports.signalements = asyncHandler(async (req, res) =>
  paginated(res, await S.listerSignalements(req.query, req.pagination), req.pagination));

exports.statistiquesSignalements = asyncHandler(async (req, res) =>
  ok(res, { statistiques: await S.statistiquesSignalements(req.query) }));
