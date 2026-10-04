'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, paginated } = require('../../../utils/response.js');
const S = require('../service/quittance.service.js');

/** Envoie un PDF en flux, sans cache intermédiaire (document privé). */
function envoyerPdf(res, { stream, taille, nom }) {
  res.setHeader('Content-Type', 'application/pdf');
  if (taille) res.setHeader('Content-Length', String(taille));
  res.setHeader('Content-Disposition', `inline; filename="${nom.replace(/[^A-Za-z0-9_.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  // En-têtes déjà partis : une coupure du stockage ne peut plus produire un
  // corps d'erreur JSON — la connexion est fermée, le client voit l'échec.
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

exports.lister = asyncHandler(async (req, res) => paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { receipt: await S.detail(req.params.id, req.ownerId) }));
exports.pdf = asyncHandler(async (req, res) => envoyerPdf(res, await S.ouvrirPdf(await S.detail(req.params.id, req.ownerId))));

// Espace locataire.
exports.listerLocataire = asyncHandler(async (req, res) => paginated(res, await S.listerPourLocataire(req.tenantIds, req.query, req.pagination), req.pagination));
exports.detailLocataire = asyncHandler(async (req, res) => ok(res, { receipt: await S.detailPourLocataire(req.params.id, req.tenantIds) }));
exports.pdfLocataire = asyncHandler(async (req, res) => envoyerPdf(res, await S.ouvrirPdf(await S.detailPourLocataire(req.params.id, req.tenantIds))));
