'use strict';

const { Joi, telephone, email } = require('../../../validations/common.js');
const { schemaParametresProprietaire } = require('../../../config/parametres.js');

const reglagesSchema = schemaParametresProprietaire.min(1);

const profilSchema = Joi.object({
  display_name: Joi.string().trim().min(2).max(150),
  company_name: Joi.string().trim().max(150).allow('', null),
  phone: telephone.allow(null),
  email: email.allow(null),
  address: Joi.string().trim().max(255).allow('', null),
  city: Joi.string().trim().max(100).allow('', null),
}).min(1);

module.exports = { reglagesSchema, profilSchema };
