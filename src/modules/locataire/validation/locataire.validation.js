'use strict';

const { Joi, telephone, email, nom, recherche, tri, pagination } = require('../../../validations/common.js');
const { codes, TYPE_PIECE_IDENTITE } = require('../../../config/enums.js');

const champs = {
  first_name: nom,
  last_name: nom,
  phone: telephone,
  email: email.allow(null, ''),
  id_document_type: Joi.string().valid(...codes(TYPE_PIECE_IDENTITE)).allow(null),
  id_document_number: Joi.string().trim().max(60).allow(null, ''),
  notes: Joi.string().trim().max(2000).allow(null, ''),
};

const creationSchema = Joi.object({
  ...champs,
  first_name: nom.required(),
  last_name: nom.required(),
  phone: telephone.required(),
  // § 54.3 : consentement recueilli par le propriétaire (le locataire peut le retirer à tout moment).
  whatsapp_consent: Joi.boolean().default(false),
  // Option A (§ 5) : envoyer l'invitation dès la création.
  send_invitation: Joi.boolean().default(false),
});

const modificationSchema = Joi.object(champs).min(1);

const listeSchema = Joi.object({
  ...pagination,
  q: recherche,
  statut: Joi.string().valid('actif', 'ancien', 'sans_bail'),
  building_id: Joi.string().guid(),
  tri: tri(['last_name', 'created_at']),
});

module.exports = { creationSchema, modificationSchema, listeSchema };
