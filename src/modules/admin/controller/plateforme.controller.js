'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/plateforme.service.js');

exports.parametres = asyncHandler(async (req, res) => ok(res, { settings: await S.listerParametres() }));

exports.modifierParametre = asyncHandler(async (req, res) =>
  ok(res, { setting: await S.modifierParametre(req.user, req.params.cle, req.body) }, 'Paramètre modifié'));

exports.diffuser = asyncHandler(async (req, res) =>
  created(res, { diffusion: await S.diffuser(req.body) }, 'Notification diffusée'));

exports.diffusions = asyncHandler(async (req, res) =>
  paginated(res, await S.historiqueDiffusions(req.pagination), req.pagination));

exports.categories = asyncHandler(async (req, res) => ok(res, { categories: await S.listerCategories(req.query) }));

exports.creerCategorie = asyncHandler(async (req, res) =>
  created(res, { category: await S.creerCategorie(req.body) }, 'Catégorie créée'));

exports.modifierCategorie = asyncHandler(async (req, res) =>
  ok(res, { category: await S.modifierCategorie(req.params.id, req.body) }, 'Catégorie modifiée'));

exports.activerCategorie = asyncHandler(async (req, res) =>
  ok(res, { category: await S.changerActivationCategorie(req.params.id, true) }, 'Catégorie activée'));

exports.desactiverCategorie = asyncHandler(async (req, res) =>
  ok(res, { category: await S.changerActivationCategorie(req.params.id, false) }, 'Catégorie désactivée'));

exports.supprimerCategorie = asyncHandler(async (req, res) => {
  await S.supprimerCategorie(req.params.id);
  return ok(res, null, 'Catégorie supprimée');
});

exports.journal = asyncHandler(async (req, res) =>
  paginated(res, await S.journal(req.query, req.pagination), req.pagination));

exports.roles = asyncHandler(async (req, res) => ok(res, await S.roles()));
