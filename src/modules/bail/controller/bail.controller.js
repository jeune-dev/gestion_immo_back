'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/bail.service.js');
const A = require('../service/accord.service.js');

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { lease: await S.detail(req.params.id, req.ownerId) }));
exports.creer = asyncHandler(async (req, res) => created(res, { lease: await S.creer(req.ownerId, req.user, req.body) }, 'Bail créé (brouillon)'));
exports.modifier = asyncHandler(async (req, res) => ok(res, { lease: await S.modifier(req.params.id, req.ownerId, req.body) }, 'Bail modifié'));

exports.activer = asyncHandler(async (req, res) => {
  const { lease, avertissements } = await S.activer(req.params.id, req.ownerId);
  return ok(res, { lease, avertissements }, 'Bail activé : échéances générées');
});

exports.annuler = asyncHandler(async (req, res) => ok(res, { lease: await S.annuler(req.params.id, req.ownerId, req.body.reason) }, 'Bail annulé'));
exports.terminer = asyncHandler(async (req, res) => ok(res, await S.terminer(req.params.id, req.ownerId, req.body), 'Bail terminé'));
exports.cloturer = asyncHandler(async (req, res) => ok(res, { lease: await S.cloturer(req.params.id, req.ownerId) }, 'Bail clôturé'));
exports.genererContrat = asyncHandler(async (req, res) => created(res, await S.genererContrat(req.params.id, req.ownerId, req.user, req.body), 'Contrat généré et partagé avec le locataire'));
exports.contrats = asyncHandler(async (req, res) => ok(res, { contracts: await S.contrats(req.params.id, req.ownerId) }));

// Accord du locataire, avenants de loyer, congé.
exports.proposer = asyncHandler(async (req, res) => ok(res, await A.proposer(req.params.id, req.ownerId), 'Bail proposé au locataire'));
exports.acceptationPapier = asyncHandler(async (req, res) => ok(res, await A.acceptationPapier(req.params.id, req.ownerId, req.user, req.fichier), 'Bail signé enregistré'));
exports.avenants = asyncHandler(async (req, res) => ok(res, { amendments: await A.avenants(req.params.id, req.ownerId) }));
exports.proposerAvenant = asyncHandler(async (req, res) => created(res, { amendment: await A.proposerAvenant(req.params.id, req.ownerId, req.user, req.body) }, 'Nouveau loyer proposé au locataire'));
exports.avenantPapier = asyncHandler(async (req, res) => ok(res, await A.avenantPapier(req.params.id, req.params.amendmentId, req.ownerId, req.user, req.fichier), 'Avenant signé : nouveau loyer appliqué'));
exports.annulerAvenant = asyncHandler(async (req, res) => ok(res, { amendment: await A.annulerAvenant(req.params.id, req.params.amendmentId, req.ownerId) }, 'Proposition retirée'));
exports.conge = asyncHandler(async (req, res) => ok(res, { lease: await A.congeProprietaire(req.params.id, req.ownerId, req.body) }, 'Congé enregistré'));
exports.annulerConge = asyncHandler(async (req, res) => ok(res, { lease: await A.annulerCongeProprietaire(req.params.id, req.ownerId) }, 'Congé retiré'));
