'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/bail.service.js');

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { lease: await S.detail(req.params.id, req.ownerId) }));
exports.creer = asyncHandler(async (req, res) => created(res, { lease: await S.creer(req.ownerId, req.user, req.body) }, 'Bail créé (brouillon)'));
exports.modifier = asyncHandler(async (req, res) => ok(res, { lease: await S.modifier(req.params.id, req.ownerId, req.body) }, 'Bail modifié'));

exports.activer = asyncHandler(async (req, res) => {
  const { lease, avertissements } = await S.activer(req.params.id, req.ownerId);
  return ok(res, { lease, avertissements }, 'Bail activé : échéances générées');
});

exports.annuler = asyncHandler(async (req, res) => ok(res, { lease: await S.annuler(req.params.id, req.ownerId, req.body.reason) }, 'Bail annulé'));
exports.terminer = asyncHandler(async (req, res) => ok(res, { lease: await S.terminer(req.params.id, req.ownerId, req.body) }, 'Bail terminé'));
exports.cloturer = asyncHandler(async (req, res) => ok(res, { lease: await S.cloturer(req.params.id, req.ownerId) }, 'Bail clôturé'));
exports.modifierLoyer = asyncHandler(async (req, res) => ok(res, await S.modifierLoyer(req.params.id, req.ownerId, req.body), 'Loyer modifié'));
exports.genererContrat = asyncHandler(async (req, res) => created(res, await S.genererContrat(req.params.id, req.ownerId, req.user, req.body), 'Contrat généré et partagé avec le locataire'));
exports.contrats = asyncHandler(async (req, res) => ok(res, { contracts: await S.contrats(req.params.id, req.ownerId) }));
