'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created } = require('../../../utils/response.js');
const S = require('../service/categorie.service.js');

exports.lister = asyncHandler(async (req, res) => ok(res, { categories: await S.lister(req.ownerId, req.query) }));
exports.creer = asyncHandler(async (req, res) => created(res, { category: await S.creer(req.ownerId, req.body) }, 'Catégorie créée'));
exports.modifier = asyncHandler(async (req, res) => ok(res, { category: await S.modifier(req.params.id, req.ownerId, req.body) }, 'Catégorie modifiée'));
exports.desactiver = asyncHandler(async (req, res) => ok(res, { category: await S.desactiver(req.params.id, req.ownerId) }, 'Catégorie désactivée'));
