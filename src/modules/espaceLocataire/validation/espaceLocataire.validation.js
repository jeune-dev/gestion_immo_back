'use strict';

const { Joi, uuid, dateIso, pagination } = require('../../../validations/common.js');
const { codes, STATUT_ECHEANCE } = require('../../../config/enums.js');

const echeancesSchema = Joi.object({
  ...pagination,
  lease_id: uuid,
  status: Joi.string().valid(...codes(STATUT_ECHEANCE)),
  a_payer: Joi.boolean(),
  du: dateIso,
  au: dateIso,
  ordre: Joi.string().valid('asc', 'desc').default('desc'),
});

const consentementSchema = Joi.object({
  accorde: Joi.boolean().required(),
  tenant_id: uuid,
});

/** Refus d'un bail ou d'un avenant : le motif est transmis au bailleur. */
const refusSchema = Joi.object({ reason: Joi.string().trim().min(3).max(1000).required() });

const congeSchema = Joi.object({
  planned_exit_date: dateIso.required(),
  reason: Joi.string().trim().max(1000).allow('', null),
});

/** Contestation d'un remboursement. */
const contestationSchema = Joi.object({ message: Joi.string().trim().min(5).max(2000).required() });

module.exports = {
  echeancesSchema, consentementSchema, refusSchema, congeSchema, contestationSchema, paginationSchema: Joi.object(pagination),
};
