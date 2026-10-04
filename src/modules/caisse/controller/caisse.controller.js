'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/caisse.service.js');

exports.journal = asyncHandler(async (req, res) => paginated(res, await S.journal(req.ownerId, req.query, req.pagination), req.pagination));
exports.synthese = asyncHandler(async (req, res) => ok(res, { caisse: await S.synthese(req.ownerId, req.query) }));
exports.autreRevenu = asyncHandler(async (req, res) => created(res, { movement: await S.ajouterAutreRevenu(req.ownerId, req.user, req.body) }, 'Revenu enregistré'));
exports.annuler = asyncHandler(async (req, res) => ok(res, { movement: await S.annulerManuel(req.ownerId, req.params.id, req.body.reason) }, 'Mouvement annulé'));
