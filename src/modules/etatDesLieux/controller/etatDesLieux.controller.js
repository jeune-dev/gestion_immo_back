'use strict';

const { pipeline } = require('stream/promises');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/etatDesLieux.service.js');

/**
 * Envoi du PDF : l'exemplaire archivé est diffusé en flux (jamais chargé en
 * mémoire), un PDF généré à la volée est envoyé tel quel. Pas de cache :
 * un brouillon change à chaque saisie.
 */
async function envoyerPdf(res, { flux, taille, contenu, nom }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${nom}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  if (contenu) {
    res.setHeader('Content-Length', contenu.length);
    return res.end(contenu);
  }
  if (taille) res.setHeader('Content-Length', taille);
  return pipeline(flux, res);
}

// ── Propriétaire ───────────────────────────────────────────────────────────
exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { inspection: await S.detail(req.params.id, req.ownerId) }));
exports.creer = asyncHandler(async (req, res) => created(res, { inspection: await S.creer(req.ownerId, req.user, req.body) }, 'État des lieux créé (brouillon) avec la trame de pièces'));
exports.modifier = asyncHandler(async (req, res) => ok(res, { inspection: await S.modifier(req.params.id, req.ownerId, req.body) }, 'État des lieux modifié'));
exports.supprimer = asyncHandler(async (req, res) => {
  await S.supprimer(req.params.id, req.ownerId);
  return ok(res, null, 'État des lieux supprimé');
});

exports.ajouterPiece = asyncHandler(async (req, res) => created(res, { room: await S.ajouterPiece(req.params.id, req.ownerId, req.body) }, 'Pièce ajoutée'));
exports.modifierPiece = asyncHandler(async (req, res) => ok(res, { room: await S.modifierPiece(req.params.id, req.params.roomId, req.ownerId, req.body) }, 'Pièce modifiée'));
exports.supprimerPiece = asyncHandler(async (req, res) => {
  await S.supprimerPiece(req.params.id, req.params.roomId, req.ownerId);
  return ok(res, null, 'Pièce supprimée');
});

exports.ajouterElement = asyncHandler(async (req, res) => created(res, { item: await S.ajouterElement(req.params.id, req.params.roomId, req.ownerId, req.body) }, 'Élément ajouté'));
exports.modifierElement = asyncHandler(async (req, res) => ok(res, { item: await S.modifierElement(req.params.id, req.params.itemId, req.ownerId, req.body) }, 'Élément modifié'));
exports.supprimerElement = asyncHandler(async (req, res) => {
  await S.supprimerElement(req.params.id, req.params.itemId, req.ownerId);
  return ok(res, null, 'Élément supprimé');
});

exports.saisie = asyncHandler(async (req, res) => ok(res, { inspection: await S.saisie(req.params.id, req.ownerId, req.body) }, 'Saisie enregistrée'));
exports.ajouterPhoto = asyncHandler(async (req, res) => created(res, { photo: await S.ajouterPhoto(req.params.id, req.params.itemId, req.ownerId, req.user, req.fichier, req.body) }, 'Photo ajoutée'));
exports.supprimerPhoto = asyncHandler(async (req, res) => {
  await S.supprimerPhoto(req.params.id, req.params.photoId, req.ownerId);
  return ok(res, null, 'Photo supprimée');
});

exports.soumettre = asyncHandler(async (req, res) => ok(res, { inspection: await S.soumettre(req.params.id, req.ownerId) }, 'État des lieux soumis au locataire'));
exports.corriger = asyncHandler(async (req, res) => created(res, { inspection: await S.corriger(req.params.id, req.ownerId, req.user) }, 'Nouvelle version créée (brouillon)'));
exports.comparaison = asyncHandler(async (req, res) => ok(res, { comparaison: await S.comparaison(req.ownerId, req.query.lease_id) }));
exports.pdf = asyncHandler(async (req, res) => envoyerPdf(res, await S.pdfProprietaire(req.params.id, req.ownerId)));

// ── Locataire ──────────────────────────────────────────────────────────────
exports.listerLocataire = asyncHandler(async (req, res) => paginated(res, await S.listerLocataire(req.tenantIds, req.query, req.pagination), req.pagination));
exports.detailLocataire = asyncHandler(async (req, res) => ok(res, { inspection: await S.detailLocataire(req.params.id, req.tenantIds) }));
exports.pdfLocataire = asyncHandler(async (req, res) => envoyerPdf(res, await S.pdfLocataire(req.params.id, req.tenantIds)));
exports.accepter = asyncHandler(async (req, res) => ok(res, { inspection: await S.accepter(req.params.id, req.tenantIds, req.user) }, 'État des lieux accepté'));
exports.contester = asyncHandler(async (req, res) => ok(res, { inspection: await S.contester(req.params.id, req.tenantIds, req.user, req.body.comment) }, 'Contestation transmise au propriétaire'));
