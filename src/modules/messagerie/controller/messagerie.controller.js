'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/messagerie.service.js');

// ── Espace propriétaire ───────────────────────────────────────────────────

exports.listerFils = asyncHandler(async (req, res) =>
  paginated(res, await S.listerFils(req.ownerId, req.pagination), req.pagination));

exports.messagesFil = asyncHandler(async (req, res) =>
  paginated(res, await S.messagesFil(req.params.id, req.ownerId, req.pagination), req.pagination));

exports.envoyer = asyncHandler(async (req, res) =>
  created(res, { message: await S.envoyerProprietaire(req.ownerId, req.user, req.params.tenantId, req.body) }, 'Message envoyé'));

exports.envoyerPhoto = asyncHandler(async (req, res) =>
  created(res, { message: await S.envoyerProprietaire(req.ownerId, req.user, req.params.tenantId, req.body, req.fichier) }, 'Photo envoyée'));

exports.marquerLu = asyncHandler(async (req, res) =>
  ok(res, await S.marquerLuProprietaire(req.params.id, req.ownerId), 'Messages marqués comme lus'));

// ── Espace locataire ──────────────────────────────────────────────────────

exports.listerFilsLocataire = asyncHandler(async (req, res) =>
  paginated(res, await S.listerFilsLocataire(req.tenantIds, req.pagination), req.pagination));

exports.messagesFilLocataire = asyncHandler(async (req, res) =>
  paginated(res, await S.messagesFilLocataire(req.params.threadId, req.tenantIds, req.pagination), req.pagination));

exports.envoyerLocataire = asyncHandler(async (req, res) =>
  created(res, { message: await S.envoyerLocataire(req.params.threadId, req.tenantIds, req.user, req.body) }, 'Message envoyé'));

exports.envoyerPhotoLocataire = asyncHandler(async (req, res) =>
  created(res, { message: await S.envoyerLocataire(req.params.threadId, req.tenantIds, req.user, req.body, req.fichier) }, 'Photo envoyée'));

exports.marquerLuLocataire = asyncHandler(async (req, res) =>
  ok(res, await S.marquerLuLocataire(req.params.threadId, req.tenantIds), 'Messages marqués comme lus'));
