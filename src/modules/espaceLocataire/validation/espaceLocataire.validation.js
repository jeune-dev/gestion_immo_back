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

module.exports = { echeancesSchema, consentementSchema, paginationSchema: Joi.object(pagination) };
