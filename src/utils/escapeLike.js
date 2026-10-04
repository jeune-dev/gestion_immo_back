'use strict';

/**
 * escapeLike.js — échappe les jokers LIKE (% et _) et le caractère
 * d'échappement SQL dans un terme de recherche, pour qu'un utilisateur
 * ne puisse pas modifier le motif de recherche à sa guise.
 *
 * PostgreSQL LIKE : l'échappement par défaut est le backslash.
 * Utiliser conjointement : { [Op.iLike]: `%${escapeLike(terme)}%` }
 */
function escapeLike(terme) {
  return String(terme == null ? '' : terme)
    .replace(/[\\%_]/g, (c) => `\\${c}`);
}

module.exports = escapeLike;
