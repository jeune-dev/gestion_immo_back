'use strict';

const { Joi, uuid, montant, recherche, tri, pagination, dateIso } = require('../../../validations/common.js');
const { codes, TYPE_APPARTEMENT, STATUT_APPARTEMENT } = require('../../../config/enums.js');

const champs = {
  number: Joi.string().trim().min(1).max(30),
  floor: Joi.number().integer().min(-5).max(300).allow(null),
  type: Joi.string().valid(...codes(TYPE_APPARTEMENT)),
  surface: Joi.number().positive().max(100000).precision(2).allow(null),
  rooms_count: Joi.number().integer().min(0).max(100).allow(null),
  rent_amount: montant,
  charges_amount: montant,
  charge_coefficient: Joi.number().positive().max(1000000).precision(4),
  is_furnished: Joi.boolean(),
  description: Joi.string().trim().max(5000).allow('', null),
};

const creationSchema = Joi.object({
  ...champs,
  building_id: uuid.required(),
  number: champs.number.required(),
  type: champs.type.required(),
  rent_amount: montant.required(),
});

const modificationSchema = Joi.object(champs).min(1);

// Statut MANUEL : « occupé » n'est jamais posé à la main (§ 41, voir le service).
const statutSchema = Joi.object({
  status: Joi.string().valid('disponible', 'en_travaux', 'indisponible').required(),
});

const listeSchema = Joi.object({
  ...pagination,
  building_id: uuid,
  status: Joi.string().valid(...codes(STATUT_APPARTEMENT)),
  type: Joi.string().valid(...codes(TYPE_APPARTEMENT)),
  q: recherche,
  tri: tri(['number', 'floor', 'rent_amount', 'created_at']),
});

const historiqueSchema = Joi.object({
  ...pagination,
  du: dateIso,
  au: dateIso,
});

const rentabiliteSchema = Joi.object({
  du: dateIso.required(),
  au: dateIso.required(),
});

module.exports = { creationSchema, modificationSchema, statutSchema, listeSchema, historiqueSchema, rentabiliteSchema };
