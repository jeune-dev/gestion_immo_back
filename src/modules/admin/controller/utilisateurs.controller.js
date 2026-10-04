'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/utilisateurs.service.js');

exports.lister = asyncHandler(async (req, res) =>
  paginated(res, await S.lister(req.query, req.pagination), req.pagination));

exports.detail = asyncHandler(async (req, res) => ok(res, { user: await S.detail(req.params.id) }));

exports.creer = asyncHandler(async (req, res) =>
  created(res, { user: await S.creerSuperAdmin(req.user, req.body) }, 'Super administrateur créé'));

exports.desactiver = asyncHandler(async (req, res) =>
  ok(res, { user: await S.desactiver(req.user, req.params.id, req.body) }, 'Compte désactivé'));

exports.activer = asyncHandler(async (req, res) =>
  ok(res, { user: await S.activer(req.params.id) }, 'Compte activé'));

exports.deverrouiller = asyncHandler(async (req, res) =>
  ok(res, { user: await S.deverrouiller(req.params.id) }, 'Compte déverrouillé'));

exports.reinitialiserAcces = asyncHandler(async (req, res) =>
  ok(res, await S.reinitialiserAcces(req.user, req.params.id, req.body),
    'Accès réinitialisé : transmettez le mot de passe provisoire par un canal sûr (il ne sera plus affiché).'));
