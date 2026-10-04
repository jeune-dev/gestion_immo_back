'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/incident.service.js');

// ── Espace propriétaire ─────────────────────────────────────────────────────
exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { incident: await S.detail(req.params.id, req.ownerId) }));
exports.creer = asyncHandler(async (req, res) => created(res, { incident: await S.creer(req.ownerId, req.user, req.body) }, 'Incident enregistré'));
exports.analyser = asyncHandler(async (req, res) => ok(res, { incident: await S.analyser(req.params.id, req.ownerId, req.body) }, 'Incident en analyse'));
exports.rejeter = asyncHandler(async (req, res) => ok(res, { incident: await S.rejeter(req.params.id, req.ownerId, req.body) }, 'Incident rejeté'));
exports.resoudre = asyncHandler(async (req, res) => ok(res, { incident: await S.resoudre(req.params.id, req.ownerId, req.body) }, 'Incident résolu'));
exports.creerTravaux = asyncHandler(async (req, res) => created(res, { work_order: await S.creerTravaux(req.params.id, req.ownerId, req.user, req.body) }, 'Travaux planifiés'));

// ── Espace locataire ────────────────────────────────────────────────────────
exports.mesDemandes = asyncHandler(async (req, res) => paginated(res, await S.listerPourLocataire(req.tenantIds, req.query, req.pagination), req.pagination));
exports.maDemande = asyncHandler(async (req, res) => ok(res, { incident: await S.detailPourLocataire(req.params.id, req.tenantIds) }));

/** 201 à la création ; 200 quand la même `client_reference` a déjà été synchronisée (§ 34). */
exports.signaler = asyncHandler(async (req, res) => {
  const { incident, rejoue } = await S.signaler(req.tenantIds, req.user, req.body);
  return rejoue ? ok(res, { incident }, 'Demande déjà enregistrée') : created(res, { incident }, 'Problème signalé au propriétaire');
});

exports.ajouterPiece = asyncHandler(async (req, res) => created(res, { document: await S.ajouterPiece(req.params.id, req.tenantIds, req.user, req.fichier) }, 'Pièce jointe ajoutée'));
