'use strict';

const { Joi, recherche, tri, pagination } = require('../../../validations/common.js');

const champs = {
  name: Joi.string().trim().min(1).max(150),
  address: Joi.string().trim().min(1).max(255),
  district: Joi.string().trim().max(100).allow('', null),
  city: Joi.string().trim().min(1).max(100),
  floors_count: Joi.number().integer().min(0).max(300).allow(null),
  declared_apartments_count: Joi.number().integer().min(0).max(10000).allow(null),
  description: Joi.string().trim().max(5000).allow('', null),
};

const creationSchema = Joi.object({
  ...champs,
  name: champs.name.required(),
  address: champs.address.required(),
  city: champs.city.required(),
});

const modificationSchema = Joi.object(champs).min(1);

const listeSchema = Joi.object({
  ...pagination,
  q: recherche,
  city: Joi.string().trim().max(100),
  tri: tri(['name', 'city', 'created_at']),
});

module.exports = { creationSchema, modificationSchema, listeSchema };
