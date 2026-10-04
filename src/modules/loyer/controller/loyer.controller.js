'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, paginated } = require('../../../utils/response.js');
const S = require('../service/echeance.service.js');

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { schedule: await S.detail(req.params.id, req.ownerId) }));
exports.annuler = asyncHandler(async (req, res) => ok(res, { schedule: await S.annuler(req.params.id, req.ownerId, req.body.reason) }, 'Échéance annulée'));
