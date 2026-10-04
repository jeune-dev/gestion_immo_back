'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created } = require('../../../utils/response.js');
const S = require('../service/plans.service.js');

exports.lister = asyncHandler(async (req, res) => ok(res, { plans: await S.lister(req.query) }));

exports.detail = asyncHandler(async (req, res) => ok(res, { plan: await S.detail(req.params.id) }));

exports.creer = asyncHandler(async (req, res) => created(res, { plan: await S.creer(req.body) }, 'Plan créé'));

exports.modifier = asyncHandler(async (req, res) =>
  ok(res, { plan: await S.modifier(req.params.id, req.body) }, 'Plan modifié'));

exports.activer = asyncHandler(async (req, res) =>
  ok(res, { plan: await S.changerStatut(req.params.id, 'actif') }, 'Plan activé'));

exports.desactiver = asyncHandler(async (req, res) =>
  ok(res, { plan: await S.changerStatut(req.params.id, 'inactif') }, 'Plan désactivé'));

exports.supprimer = asyncHandler(async (req, res) => {
  await S.supprimer(req.params.id);
  return ok(res, null, 'Plan supprimé');
});
