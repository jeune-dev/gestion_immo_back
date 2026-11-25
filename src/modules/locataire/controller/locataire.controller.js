'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/locataire.service.js');

/**
 * Invitation renvoyée au propriétaire : l'échéance et le canal SEULEMENT.
 * Le code et le lien ne lui sont plus communiqués (constat E2) : ils partent
 * sur le WhatsApp du locataire, seule preuve qu'il possède ce numéro.
 */
const formatInvitation = (inv, canal) => inv && ({ expires_at: inv.expiresAt, canal });

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.fiche = asyncHandler(async (req, res) => ok(res, { tenant: await S.fiche(req.params.id, req.ownerId) }));

exports.creer = asyncHandler(async (req, res) => {
  const { tenant, invitation, canal } = await S.creer(req.ownerId, req.user, req.body);
  return created(res, { tenant, invitation: formatInvitation(invitation, canal) }, 'Locataire enregistré');
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
