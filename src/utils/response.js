'use strict';

/**
 * Enveloppe de réponse HOMOGÈNE pour toute l'API (reprise de Widjila).
 *
 *   Succès : { success: true,  message, data }
 *   Liste  : { success: true,  message, data: { items, pagination } }
 *   Erreur : { success: false, message, error: { code, message, details? }, requestId }
 *            (produite exclusivement par errorHandler.middleware.js)
 */

const ok = (res, data, message = 'Succès', status = 200) =>
  res.status(status).json({ success: true, message, data });

const created = (res, data, message = 'Créé avec succès') =>
  res.status(201).json({ success: true, message, data });

/**
 * Liste paginée.
 * @param {import('express').Response} res
 * @param {{ rows: any[], count: number }} resultat
 * @param {{ page: number, limit: number }} pagination
 */
const paginated = (res, { rows, count }, { page, limit }, message = 'Succès') =>
  res.status(200).json({
    success: true,
    message,
    data: {
      items: rows,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.max(1, Math.ceil(count / limit)),
      },
    },
  });

module.exports = { ok, created, paginated };
