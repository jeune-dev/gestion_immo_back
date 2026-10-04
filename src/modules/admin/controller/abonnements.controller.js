'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/abonnements.service.js');
const AbonnementService = require('../../abonnement/service/abonnement.service.js');

exports.lister = asyncHandler(async (req, res) =>
  paginated(res, await S.lister(req.query, req.pagination), req.pagination));

exports.detail = asyncHandler(async (req, res) => ok(res, { subscription: await S.detail(req.params.id) }));

exports.suspendre = asyncHandler(async (req, res) =>
  ok(res, { subscription: await S.suspendre(req.params.id, req.body) }, 'Abonnement suspendu'));

exports.reactiver = asyncHandler(async (req, res) =>
  ok(res, { subscription: await S.reactiver(req.params.id) }, 'Abonnement rétabli'));

exports.annuler = asyncHandler(async (req, res) =>
  ok(res, { subscription: await S.annuler(req.params.id, req.body) }, 'Abonnement annulé'));

exports.activer = asyncHandler(async (req, res) =>
  created(res, await AbonnementService.activerManuellement(req.user, req.params.ownerId, req.body), 'Abonnement activé'));

exports.paiements = asyncHandler(async (req, res) =>
  paginated(res, await S.listerPaiements(req.query, req.pagination), req.pagination));

exports.statistiquesLoyers = asyncHandler(async (req, res) =>
  ok(res, { statistiques: await S.statistiquesLoyers(req.query) }));
