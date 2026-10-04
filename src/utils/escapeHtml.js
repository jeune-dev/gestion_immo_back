'use strict';

/** Échappement HTML pour les gabarits d'e-mail (protection XSS). */
const CARACTERES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

module.exports = (valeur) => String(valeur ?? '').replace(/[&<>"']/g, (c) => CARACTERES[c]);
