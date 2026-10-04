'use strict';

const { Joi, uuid, tri, pagination } = require('../../../validations/common.js');
const {
  TYPE_ETAT_DES_LIEUX, STATUT_ETAT_DES_LIEUX, ELEMENT_ETAT_DES_LIEUX, ETAT_ELEMENT, codes,
} = require('../../../config/enums.js');

/** Statuts qu'un locataire peut filtrer (le brouillon ne lui est jamais montré). */
const STATUTS_LOCATAIRE = ['soumis', 'accepte', 'conteste', 'remplace'];

const compteur = Joi.number().min(0).max(999_999_999).precision(3).allow(null);
const commentaire = Joi.string().trim().max(2000).allow('', null);

// § 52.2 « parties présentes » : propriétaire, locataire, mandataire, témoin…
const partie = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  role: Joi.string().trim().min(1).max(60).required(),
});

const entete = {
  performed_at: Joi.date().iso().allow(null),
  parties_present: Joi.array().items(partie).max(10),
  water_meter: compteur,
  electricity_meter: compteur,
  keys_count: Joi.number().integer().min(0).max(100).allow(null),
  keys_details: Joi.string().trim().max(2000).allow('', null),
  general_observations: Joi.string().trim().max(5000).allow('', null),
};

const creationSchema = Joi.object({
  lease_id: uuid.required(),
  type: Joi.string().valid(...codes(TYPE_ETAT_DES_LIEUX)).required(),
  performed_at: entete.performed_at,
  parties_present: entete.parties_present,
  // Référence de l'opération créée hors ligne sur le mobile (§ 34) : tracée au
  // journal ; le dédoublonnage repose sur l'en-tête Idempotency-Key.
  client_reference: Joi.string().trim().max(64).pattern(/^[A-Za-z0-9_.:-]+$/),
});

const modificationSchema = Joi.object(entete).min(1);

const elementCreation = Joi.object({
  element: Joi.string().valid(...codes(ELEMENT_ETAT_DES_LIEUX)).required(),
  label: Joi.string().trim().max(120).allow('', null),
  condition: Joi.string().valid(...codes(ETAT_ELEMENT)),
  comment: commentaire,
  position: Joi.number().integer().min(0).max(500),
});

const pieceSchema = Joi.object({
  name: Joi.string().trim().min(1).max(80).required(),
  notes: Joi.string().trim().max(2000).allow('', null),
  position: Joi.number().integer().min(0).max(500),
  // Absent : éléments proposés selon la nature de la pièce (cuisine, WC…).
  items: Joi.array().items(Joi.object({
    element: Joi.string().valid(...codes(ELEMENT_ETAT_DES_LIEUX)).required(),
    label: Joi.string().trim().max(120).allow('', null),
  })).max(30),
});

const pieceModificationSchema = Joi.object({
  name: Joi.string().trim().min(1).max(80),
  notes: Joi.string().trim().max(2000).allow('', null),
  position: Joi.number().integer().min(0).max(500),
}).min(1);

const elementSchema = elementCreation;

const elementModificationSchema = Joi.object({
  condition: Joi.string().valid(...codes(ETAT_ELEMENT)),
  comment: commentaire,
  label: Joi.string().trim().max(120).allow('', null),
  position: Joi.number().integer().min(0).max(500),
}).min(1);

/** § 52.4 — saisie hors ligne synchronisée d'un bloc. */
const saisieSchema = Joi.object({
  items: Joi.array().items(Joi.object({
    item_id: uuid.required(),
    condition: Joi.string().valid(...codes(ETAT_ELEMENT)).required(),
    comment: commentaire,
  })).min(1).max(1000).unique('item_id').required(),
});

/** Horodatage de prise de vue fourni par le téléphone (§ 52.4), champ du formulaire multipart. */
const photoSchema = Joi.object({
  captured_at: Joi.date().iso().allow('', null).empty(''),
});

const contestationSchema = Joi.object({
  comment: Joi.string().trim().min(10).max(2000).required(),
});

const listeSchema = Joi.object({
  ...pagination,
  lease_id: uuid,
  apartment_id: uuid,
  tenant_id: uuid,
  type: Joi.string().valid(...codes(TYPE_ETAT_DES_LIEUX)),
  status: Joi.string().valid(...codes(STATUT_ETAT_DES_LIEUX)),
  tri: tri(['created_at', 'performed_at', 'submitted_at']),
});

const listeLocataireSchema = Joi.object({
  ...pagination,
  lease_id: uuid,
  type: Joi.string().valid(...codes(TYPE_ETAT_DES_LIEUX)),
  status: Joi.string().valid(...STATUTS_LOCATAIRE),
  tri: tri(['created_at', 'performed_at', 'submitted_at']),
});

const comparaisonSchema = Joi.object({ lease_id: uuid.required() });

const paramPiece = Joi.object({ id: uuid.required(), roomId: uuid.required() });
const paramElement = Joi.object({ id: uuid.required(), itemId: uuid.required() });
const paramPhoto = Joi.object({ id: uuid.required(), photoId: uuid.required() });

module.exports = {
  creationSchema, modificationSchema, pieceSchema, pieceModificationSchema, elementSchema, elementModificationSchema,
  saisieSchema, photoSchema, contestationSchema, listeSchema, listeLocataireSchema, comparaisonSchema,
  paramPiece, paramElement, paramPhoto,
};
