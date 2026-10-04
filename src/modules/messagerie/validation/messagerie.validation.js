'use strict';

const { Joi, uuid, pagination } = require('../../../validations/common.js');

/** § 54.1 : message texte, borné (pas de pavé illimité dans la base ni dans une notification). */
const LONGUEUR_MAX = 4000;

const rattachement = {
  related_type: Joi.string().valid('incident', 'rent_schedule', 'work_order'),
  related_id: uuid,
};

const texteSchema = Joi.object({
  body: Joi.string().trim().min(1).max(LONGUEUR_MAX).required(),
  ...rattachement,
}).and('related_type', 'related_id');

/** Message photo (multipart) : légende facultative. */
const photoSchema = Joi.object({
  body: Joi.string().trim().max(LONGUEUR_MAX).allow(''),
  ...rattachement,
}).and('related_type', 'related_id');

const listeSchema = Joi.object({ ...pagination });

const paramLocataire = Joi.object({ tenantId: uuid.required() });
const paramFil = Joi.object({ threadId: uuid.required() });

module.exports = {
  texteSchema, photoSchema, listeSchema, paramLocataire, paramFil, LONGUEUR_MAX,
};
