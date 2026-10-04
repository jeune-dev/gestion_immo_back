'use strict';

const { Joi, uuid, dateIso, tri, pagination } = require('../../../validations/common.js');
const { codes, STATUT_ECHEANCE } = require('../../../config/enums.js');

const listeSchema = Joi.object({
  ...pagination,
  lease_id: uuid,
  tenant_id: uuid,
  apartment_id: uuid,
  building_id: uuid,
  status: Joi.string().valid(...codes(STATUT_ECHEANCE)),
  // § 48 « Qui n'a pas payé ? » : échéances en retard ou partiellement payées.
  impayes: Joi.boolean(),
  du: dateIso,
  au: dateIso,
  tri: tri(['due_date', 'amount_due', 'status']),
});

const annulationSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
});

module.exports = { listeSchema, annulationSchema };
