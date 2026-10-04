'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok } = require('../../../utils/response.js');
const S = require('../service/espaceProprietaire.service.js');

exports.lire = asyncHandler(async (req, res) => ok(res, await S.lire(req.ownerId)));
exports.modifierReglages = asyncHandler(async (req, res) => ok(res, { settings: await S.modifierReglages(req.ownerId, req.body) }, 'Paramètres enregistrés'));
exports.modifierProfil = asyncHandler(async (req, res) => ok(res, { owner: await S.modifierProfil(req.ownerId, req.body) }, 'Informations du bailleur enregistrées'));
