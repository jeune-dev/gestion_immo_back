'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/depense.service.js');

/**
 * Réponse de création : 201 pour une nouvelle dépense, 200 quand la même
 * `client_reference` a déjà été synchronisée (§ 34) — le mobile marque alors
 * l'opération locale comme synchronisée sans doublon.
 */
const repondreCreation = (res, { expense, rejoue }) => (rejoue
  ? ok(res, { expense }, 'Dépense déjà enregistrée')
  : created(res, { expense }, 'Dépense enregistrée'));

exports.repondreCreation = repondreCreation;
exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { expense: await S.detail(req.params.id, req.ownerId) }));
exports.creer = asyncHandler(async (req, res) => repondreCreation(res, await S.creer(req.ownerId, req.user, req.body)));
exports.modifier = asyncHandler(async (req, res) => ok(res, { expense: await S.modifier(req.params.id, req.ownerId, req.body) }, 'Dépense modifiée'));
exports.annuler = asyncHandler(async (req, res) => ok(res, { expense: await S.annuler(req.params.id, req.ownerId, req.user, req.body.reason) }, 'Dépense annulée'));
exports.justificatif = asyncHandler(async (req, res) => created(res, { document: await S.ajouterJustificatif(req.params.id, req.ownerId, req.user, req.fichier) }, 'Justificatif ajouté'));
