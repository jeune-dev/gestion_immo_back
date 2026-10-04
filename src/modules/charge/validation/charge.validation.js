'use strict';

const { Joi, uuid, tri, pagination } = require('../../../validations/common.js');
const { codes, STATUT_CHARGE } = require('../../../config/enums.js');
// Date existante au calendrier : « 2026-02-30 » ferait échouer PostgreSQL (500).
const { dateReelle: dateIso } = require('../../rapport/validation/rapport.validation.js');

/** Charges refacturées — liste côté propriétaire (filtres sur l'échéance `due_date`). */
const listeSchema = Joi.object({
  ...pagination,
  tenant_id: uuid,
  lease_id: uuid,
  apartment_id: uuid,
  building_id: uuid,
  charge_invoice_id: uuid,
  status: Joi.string().valid(...codes(STATUT_CHARGE)),
  du: dateIso,
  au: dateIso,
  tri: tri(['due_date', 'amount', 'status', 'created_at']),
});

/** « Mes charges » (§ 28) : filtres limités à ce qui concerne le locataire. */
const listeLocataireSchema = Joi.object({
  ...pagination,
  status: Joi.string().valid(...codes(STATUT_CHARGE)),
  tri: tri(['due_date', 'amount', 'created_at']),
});

module.exports = { listeSchema, listeLocataireSchema };
