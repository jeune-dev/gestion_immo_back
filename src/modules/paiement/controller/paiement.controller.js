'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/paiement.service.js');
const R = require('../service/rapprochement.service.js');

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { payment: await S.detail(req.params.id, req.ownerId) }));
exports.encaisser = asyncHandler(async (req, res) => created(res, await S.encaisser(req.ownerId, req.user, req.body), 'Paiement enregistré'));
exports.rembourser = asyncHandler(async (req, res) => ok(res, { payment: await S.rembourser(req.ownerId, req.user, req.params.id, req.body) }, 'Paiement remboursé'));
exports.quittances = asyncHandler(async (req, res) => ok(res, { receipts: await S.quittancesDuPaiement(req.params.id, req.ownerId) }));

exports.transactions = asyncHandler(async (req, res) => paginated(res, await S.listerTransactions(req.ownerId, req.query, req.pagination), req.pagination));
exports.transaction = asyncHandler(async (req, res) => ok(res, { transaction: await S.detailTransaction(req.params.id, req.ownerId) }));
exports.validerPreuve = asyncHandler(async (req, res) => ok(res, await S.validerPreuve(req.ownerId, req.user, req.params.id), 'Paiement validé'));
exports.rejeterPreuve = asyncHandler(async (req, res) => ok(res, { transaction: await S.rejeterPreuve(req.ownerId, req.user, req.params.id, req.body) }, 'Preuve refusée'));

exports.rapprochements = asyncHandler(async (req, res) => paginated(res, await R.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.resoudre = asyncHandler(async (req, res) => ok(res, await R.resoudre(req.ownerId, req.user, req.params.id, req.body), 'Paiement rapproché'));
exports.rejeterRapprochement = asyncHandler(async (req, res) => ok(res, { entry: await R.rejeter(req.ownerId, req.user, req.params.id, req.body) }, 'Entrée rejetée'));

exports.moyens = asyncHandler(async (req, res) => ok(res, { providers: await S.moyens(req.ownerId) }));
exports.configurerMoyen = asyncHandler(async (req, res) => ok(res, { provider: await S.configurerMoyen(req.ownerId, req.body) }, 'Moyen de paiement enregistré'));
