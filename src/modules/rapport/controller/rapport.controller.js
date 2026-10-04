'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, paginated } = require('../../../utils/response.js');
const S = require('../service/rapport.service.js');
const exporter = require('../service/export.js');
const { ValidationError } = require('../../../errors/AppError.js');

/**
 * Réponse CSV en pièce jointe (§ 26). Le nom de fichier ne contient que le
 * type de rapport et les dates déjà validées (AAAA-MM-JJ) : aucune donnée
 * libre dans l'en-tête.
 */
function envoyerCsv(res, type, { du, au }, contenu) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rapport-${type}_${du}_${au}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(contenu);
}

/** Rapport « objet » : JSON par défaut, CSV sur `?format=csv`. */
const rapport = (type) => asyncHandler(async (req, res) => {
  const resultat = await S[type](req.ownerId, req.query);
  if (req.query.format === 'csv') return envoyerCsv(res, type, req.query, exporter[type](resultat));
  return ok(res, { rapport: resultat });
});

exports.financier = rapport('financier');
exports.immobilier = rapport('immobilier');
exports.travaux = rapport('travaux');
exports.locataires = rapport('locataires');

/**
 * Rentabilité : liste paginée en JSON ; l'export CSV contient toutes les
 * lignes, dans la limite de EXPORT_MAX_LIGNES (constat M12) — au-delà, 422 :
 * filtrer par immeuble ou réduire la période plutôt qu'une requête sans borne.
 */
exports.rentabilite = asyncHandler(async (req, res) => {
  if (req.query.format === 'csv') {
    const plafond = Number(process.env.EXPORT_MAX_LIGNES) || 10000;
    const complet = await S.rentabilite(req.ownerId, req.query, { limit: plafond, offset: 0 });
    if (complet.count > plafond) {
      throw new ValidationError('Export trop volumineux', [`L'export est limité à ${plafond} lignes : filtrez par immeuble ou réduisez la période.`], 'EXPORT_TROP_VOLUMINEUX');
    }
    return envoyerCsv(res, 'rentabilite', req.query, exporter.rentabilite(complet));
  }
  const page = await S.rentabilite(req.ownerId, req.query, req.pagination);
  return paginated(res, page, req.pagination);
});
