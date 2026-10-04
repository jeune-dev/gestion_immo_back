'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, paginated } = require('../../../utils/response.js');
const S = require('../service/charge.service.js');

// ── Espace propriétaire ──
exports.lister = asyncHandler(async (req, res) =>
  paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));

exports.detail = asyncHandler(async (req, res) =>
  ok(res, { charge: await S.detail(req.params.id, req.ownerId) }));

// ── Espace locataire (§ 28 « Mes charges ») ──
exports.listerLocataire = asyncHandler(async (req, res) =>
  paginated(res, await S.listerLocataire(req.tenantIds, req.query, req.pagination), req.pagination));

exports.detailLocataire = asyncHandler(async (req, res) =>
  ok(res, { charge: await S.detailLocataire(req.params.id, req.tenantIds) }));
