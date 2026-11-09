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
  // § 54.3 : le consentement appartient au locataire. Il le donne dans son espace,
  // ou le propriétaire le déclare AVEC une preuve (POST /:id/consentement-whatsapp).
  // L'ancien champ est accepté pour les applications non mises à jour, puis ignoré.
  whatsapp_consent: Joi.any().strip(),
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
