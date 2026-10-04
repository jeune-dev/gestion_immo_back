'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok } = require('../../../utils/response.js');
const S = require('../service/tableauDeBord.service.js');

exports.tableauDeBord = asyncHandler(async (req, res) => ok(res, { dashboard: await S.tableauDeBord() }));
