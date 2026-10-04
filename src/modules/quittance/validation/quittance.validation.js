'use strict';

const { Joi, uuid, dateIso, tri, pagination } = require('../../../validations/common.js');

const listeSchema = Joi.object({
  ...pagination,
  lease_id: uuid,
  tenant_id: uuid,
  du: dateIso,
  au: dateIso,
  inclure_annulees: Joi.boolean().default(false),
  tri: tri(['issued_at', 'amount']),
});

module.exports = { listeSchema };
