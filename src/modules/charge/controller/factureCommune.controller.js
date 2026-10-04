'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/factureCommune.service.js');

exports.lister = asyncHandler(async (req, res) =>
  paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));

exports.aRepartir = asyncHandler(async (req, res) => ok(res, await S.aRepartir(req.ownerId)));

exports.detail = asyncHandler(async (req, res) =>
  ok(res, { invoice: await S.detail(req.params.id, req.ownerId) }));

exports.creer = asyncHandler(async (req, res) =>
  created(res, { invoice: await S.creer(req.ownerId, req.user, req.body) }, 'Facture commune enregistrée'));

exports.modifier = asyncHandler(async (req, res) =>
  ok(res, { invoice: await S.modifier(req.params.id, req.ownerId, req.body) }, 'Facture commune modifiée'));

exports.ajouterDocument = asyncHandler(async (req, res) =>
  created(res, { document: await S.ajouterDocument(req.params.id, req.ownerId, req.user, req.fichier) }, 'Justificatif ajouté'));

// Aperçu : paramètres en chaîne de requête (GET) ou dans le corps (POST).
exports.apercuQuery = asyncHandler(async (req, res) =>
  ok(res, { allocation: await S.apercu(req.params.id, req.ownerId, req.query) }));

exports.apercuCorps = asyncHandler(async (req, res) =>
  ok(res, { allocation: await S.apercu(req.params.id, req.ownerId, req.body) }));

exports.repartir = asyncHandler(async (req, res) =>
  ok(res, { invoice: await S.repartir(req.params.id, req.ownerId, req.body) }, 'Facture répartie'));

exports.annuler = asyncHandler(async (req, res) =>
  ok(res, { invoice: await S.annuler(req.params.id, req.ownerId, req.body.reason) }, 'Facture annulée'));
