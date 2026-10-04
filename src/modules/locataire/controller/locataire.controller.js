'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/locataire.service.js');

/** Invitation renvoyée au propriétaire : le code, le lien et l'échéance (jamais l'empreinte). */
const formatInvitation = (inv, canal) => inv && ({ code: inv.code, token: inv.token, expires_at: inv.expiresAt, canal });

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.fiche = asyncHandler(async (req, res) => ok(res, { tenant: await S.fiche(req.params.id, req.ownerId) }));

exports.creer = asyncHandler(async (req, res) => {
  const { tenant, invitation } = await S.creer(req.ownerId, req.user, req.body);
  return created(res, { tenant, invitation: formatInvitation(invitation, tenant.email ? 'email' : 'manuel') }, 'Locataire enregistré');
});

exports.modifier = asyncHandler(async (req, res) => ok(res, { tenant: await S.modifier(req.params.id, req.ownerId, req.body) }, 'Locataire modifié'));

exports.supprimer = asyncHandler(async (req, res) => {
  await S.supprimer(req.params.id, req.ownerId);
  return ok(res, null, 'Locataire supprimé');
});

exports.inviter = asyncHandler(async (req, res) => {
  const { invitation, canal } = await S.inviter(req.params.id, req.ownerId, req.user);
  return created(res, { invitation: formatInvitation(invitation, canal) }, 'Invitation créée');
});

exports.consentement = asyncHandler(async (req, res) =>
  ok(res, { tenant: await S.consentementWhatsapp(req.params.id, req.ownerId, req.body.accorde) }, 'Consentement WhatsApp mis à jour'));
