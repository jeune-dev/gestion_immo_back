'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/caution.service.js');

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { deposit: await S.detail(req.params.id, req.ownerId) }));
exports.verser = asyncHandler(async (req, res) => created(res, await S.verser(req.ownerId, req.user, req.params.id, req.body), 'Versement de caution enregistré'));
exports.justificatif = asyncHandler(async (req, res) => created(res, { document: await S.ajouterJustificatif(req.ownerId, req.user, req.params.id, req.fichier) }, 'Justificatif ajouté'));
exports.retenir = asyncHandler(async (req, res) => created(res, await S.retenir(req.ownerId, req.user, req.params.id, req.body), 'Retenue enregistrée'));
exports.restituer = asyncHandler(async (req, res) => created(res, await S.restituer(req.ownerId, req.user, req.params.id, req.body), 'Restitution enregistrée'));
exports.repondre = asyncHandler(async (req, res) => ok(res, await S.repondreContestation(req.ownerId, req.params.id, req.params.transactionId, req.body), 'Réponse enregistrée'));

// Espace locataire.
exports.listerLocataire = asyncHandler(async (req, res) => ok(res, { deposits: await S.listerPourLocataire(req.tenantIds) }));
exports.contester = asyncHandler(async (req, res) => ok(res, await S.contester(req.user, req.tenantIds, req.params.transactionId, req.body), 'Contestation transmise'));
