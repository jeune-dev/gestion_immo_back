'use strict';

const { Joi, uuid, pagination } = require('../../../validations/common.js');
const { ENTITE_DOCUMENT, codes } = require('../../../config/enums.js');
const { ENTITES_MANUELLES, CATEGORIES_MANUELLES } = require('../service/document.service.js');

/** Champs multipart (chaînes converties par Joi : 'true' → true, date ISO → Date). */
const televersementSchema = Joi.object({
  entity_type: Joi.string().valid(...Object.keys(ENTITES_MANUELLES)).required(),
  entity_id: uuid.required(),
  category: Joi.string().valid(...CATEGORIES_MANUELLES).required(),
  visible_to_tenant: Joi.boolean().default(false),
  // Horodatage de prise de vue fourni par le mobile (photo horodatée, § 56.2).
  captured_at: Joi.date().iso().allow(null),
});

const listeSchema = Joi.object({
  ...pagination,
  entity_type: Joi.string().valid(...codes(ENTITE_DOCUMENT)),
  entity_id: uuid,
}).and('entity_type', 'entity_id');

const fichierSchema = Joi.object({
  taille: Joi.string().valid('miniature', 'originale'),
});

const modificationSchema = Joi.object({
  visible_to_tenant: Joi.boolean().required(),
});

module.exports = { televersementSchema, listeSchema, fichierSchema, modificationSchema };
