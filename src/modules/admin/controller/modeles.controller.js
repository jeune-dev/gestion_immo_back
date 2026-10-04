'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created } = require('../../../utils/response.js');
const S = require('../service/modeles.service.js');

exports.listerBaux = asyncHandler(async (req, res) => ok(res, { templates: await S.listerBaux(req.query) }));

exports.variables = asyncHandler(async (req, res) => ok(res, { variables: S.variables() }));

exports.detailBail = asyncHandler(async (req, res) => ok(res, { template: await S.detailBail(req.params.id) }));

exports.creerBail = asyncHandler(async (req, res) =>
  created(res, { template: await S.creerBail(req.user, req.body) }, 'Version de modèle créée'));

exports.modifierBail = asyncHandler(async (req, res) =>
  ok(res, { template: await S.modifierBail(req.params.id, req.body) }, 'Modèle modifié'));

exports.publierBail = asyncHandler(async (req, res) =>
  ok(res, { template: await S.publierBail(req.user, req.params.id) }, 'Modèle publié'));

exports.archiverBail = asyncHandler(async (req, res) =>
  ok(res, { template: await S.archiverBail(req.params.id) }, 'Modèle archivé'));

exports.listerWhatsapp = asyncHandler(async (req, res) => ok(res, { templates: await S.listerWhatsapp() }));

exports.modifierWhatsapp = asyncHandler(async (req, res) =>
  ok(res, { template: await S.modifierWhatsapp(req.params.id, req.body) }, 'Modèle WhatsApp modifié'));
