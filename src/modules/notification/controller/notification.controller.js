'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, paginated } = require('../../../utils/response.js');
const S = require('../service/notificationLecture.service.js');

exports.lister = asyncHandler(async (req, res) =>
  paginated(res, await S.lister(req.user.id, req.query, req.pagination), req.pagination));

exports.compteur = asyncHandler(async (req, res) =>
  ok(res, { non_lues: await S.compterNonLues(req.user.id) }));

exports.marquerLue = asyncHandler(async (req, res) =>
  ok(res, { notification: await S.marquerLue(req.params.id, req.user.id) }, 'Notification lue'));

exports.toutLire = asyncHandler(async (req, res) =>
  ok(res, { marquees: await S.toutLire(req.user.id) }, 'Notifications marquées comme lues'));
