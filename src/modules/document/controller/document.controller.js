'use strict';

const { pipeline } = require('stream');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const logger = require('../../../utils/logger.js');
const S = require('../service/document.service.js');

/**
 * Portée de l'appelant pour le contrôle d'accès aux documents : un locataire
 * (req.tenantIds posé par la route) n'est jamais traité comme propriétaire.
 */
const acces = (req) => (req.tenantIds
  ? { ownerId: null, tenantIds: req.tenantIds }
  : { ownerId: req.ownerId, tenantIds: null });

exports.televerser = asyncHandler(async (req, res) =>
  created(res, { document: await S.televerser(req.ownerId, req.user, req.body, req.fichier) }, 'Document enregistré'));

exports.lister = asyncHandler(async (req, res) =>
  paginated(res, await S.lister(acces(req), req.query, req.pagination), req.pagination));

/**
 * Flux du fichier. Les en-têtes interdisent toute mise en cache partagée
 * (donnée personnelle : pièce d'identité, contrat) et le « sniffing » du type
 * par le navigateur — le type servi est celui détecté à la réception par la
 * signature binaire, jamais celui annoncé par le client.
 */
exports.fichier = asyncHandler(async (req, res) => {
  const { objet, mime, disposition } = await S.ouvrirFichier(req.params.id, acces(req), { miniature: req.query.taille === 'miniature' });
  res.status(200);
  res.setHeader('Content-Type', mime);
  if (Number.isFinite(objet.taille)) res.setHeader('Content-Length', String(objet.taille));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', disposition);
  pipeline(objet.stream, res, (err) => {
    // En-têtes déjà partis : la réponse ne peut plus devenir une erreur JSON,
    // la connexion est simplement coupée (le client voit un transfert incomplet).
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.warn('[document] Transfert de fichier interrompu', { document_id: req.params.id, error: err.message });
    }
  });
});

exports.lien = asyncHandler(async (req, res) =>
  ok(res, await S.lienTemporaire(req.params.id, acces(req), { miniature: req.query.taille === 'miniature' })));

exports.modifier = asyncHandler(async (req, res) =>
  ok(res, { document: await S.modifier(req.params.id, req.ownerId, req.body) }, 'Document modifié'));

exports.supprimer = asyncHandler(async (req, res) => {
  await S.supprimer(req.params.id, req.ownerId);
  return ok(res, null, 'Document supprimé');
});
