'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const AbonnementService = require('../service/abonnement.service.js');

exports.plansPublics = asyncHandler(async (req, res) =>
  ok(res, { plans: await AbonnementService.plansPublics() }));

exports.etat = asyncHandler(async (req, res) =>
  ok(res, { abonnement: await AbonnementService.etatCourant(req.ownerId) }));

exports.paiements = asyncHandler(async (req, res) =>
  paginated(res, await AbonnementService.historiquePaiements(req.ownerId, req.query, req.pagination), req.pagination));

exports.souscrire = asyncHandler(async (req, res) =>
  created(res, await AbonnementService.souscrire(req.ownerId, req.user, req.body), 'Demande de paiement créée'));
