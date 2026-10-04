'use strict';

const { Joi, pagination } = require('../../../validations/common.js');

const listeSchema = Joi.object({
  ...pagination,
  non_lues: Joi.boolean(),
});

module.exports = { listeSchema };
