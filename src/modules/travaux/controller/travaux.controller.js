'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/travaux.service.js');
const { repondreCreation } = require('../../depense/controller/depense.controller.js');

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { work_order: await S.detail(req.params.id, req.ownerId) }));
exports.creer = asyncHandler(async (req, res) => created(res, { work_order: await S.creer(req.ownerId, req.user, req.body) }, 'Travaux créés'));
exports.modifier = asyncHandler(async (req, res) => ok(res, { work_order: await S.modifier(req.params.id, req.ownerId, req.body) }, 'Travaux modifiés'));
exports.statut = asyncHandler(async (req, res) => ok(res, { work_order: await S.changerStatut(req.params.id, req.ownerId, req.user, req.body) }, 'Statut des travaux mis à jour'));
exports.photos = asyncHandler(async (req, res) => ok(res, { photos: await S.photos(req.params.id, req.ownerId) }));
exports.ajouterPhoto = asyncHandler(async (req, res) => created(res, { photo: await S.ajouterPhoto(req.params.id, req.ownerId, req.user, req.fichier, req.body) }, 'Photo ajoutée'));

exports.supprimerPhoto = asyncHandler(async (req, res) => {
  await S.supprimerPhoto(req.params.id, req.params.photoId, req.ownerId);
  return ok(res, null, 'Photo retirée');
});

exports.depense = asyncHandler(async (req, res) => repondreCreation(res, await S.ajouterDepense(req.params.id, req.ownerId, req.user, req.body)));
