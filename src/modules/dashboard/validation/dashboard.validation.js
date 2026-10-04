'use strict';

const { Joi, uuid } = require('../../../validations/common.js');

/** Mois calendaire AAAA-MM. */
const mois = Joi.string().trim().pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
  .message('{{#label}} doit être un mois au format AAAA-MM');

const tableauDeBordSchema = Joi.object({
  mois,
  building_id: uuid,
});

// § 6 « Graphiques prévus » : fenêtre glissante bornée à 24 mois (une série
// par mois, calculée en une requête — la borne protège la base).
const graphiquesSchema = Joi.object({
  mois_fin: mois,
  nb_mois: Joi.number().integer().min(1).max(24).default(12),
  building_id: uuid,
});

module.exports = { tableauDeBordSchema, graphiquesSchema };
