'use strict';

const { Joi, telephone, email, recherche, tri, pagination } = require('../../../validations/common.js');
const { codes, METIER_ARTISAN } = require('../../../config/enums.js');

// § 24 : nom, téléphone, métier, email, notes.
const champs = {
  name: Joi.string().trim().min(1).max(150),
  phone: telephone.allow(null, ''),
  trade: Joi.string().valid(...codes(METIER_ARTISAN)),
  email: email.allow(null, ''),
  notes: Joi.string().trim().max(2000).allow(null, ''),
};

const creationSchema = Joi.object({
  ...champs,
  name: champs.name.required(),
  trade: champs.trade.required(),
});

const modificationSchema = Joi.object(champs).min(1);

const listeSchema = Joi.object({
  ...pagination,
  q: recherche,
  trade: Joi.string().valid(...codes(METIER_ARTISAN)),
  is_active: Joi.boolean(),
  tri: tri(['name', 'trade', 'created_at']),
});

module.exports = { creationSchema, modificationSchema, listeSchema };
