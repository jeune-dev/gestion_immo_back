'use strict';

const { Joi, uuid, montantPositif, tri, pagination } = require('../../../validations/common.js');
const { codes, MODE_PAIEMENT, STATUT_DEPENSE, GROUPE_CAISSE_SORTIE } = require('../../../config/enums.js');
// Date existante au calendrier : « 2026-02-30 » ferait échouer PostgreSQL (500).
const { dateReelle: dateIso } = require('../../rapport/validation/rapport.validation.js');

/** Référence générée par le mobile pour une saisie hors ligne (§ 34). */
const referenceClient = Joi.string().trim().pattern(/^[A-Za-z0-9_.:-]{8,64}$/)
  .message('{{#label}} doit contenir 8 à 64 caractères alphanumériques');

const communs = {
  amount: montantPositif.required(),
  method: Joi.string().valid(...codes(MODE_PAIEMENT)).required(),
  spent_on: dateIso.required(),
  description: Joi.string().trim().max(500).allow(null, ''),
  contractor_id: uuid.allow(null),
  client_reference: referenceClient,
};

const creationSchema = Joi.object({
  ...communs,
  category_id: uuid.required(),
  building_id: uuid.required(),
  apartment_id: uuid.allow(null),
  work_order_id: uuid.allow(null),
});

/** Dépense d'un chantier : immeuble / appartement / travaux viennent des travaux. */
const depenseTravauxSchema = Joi.object({
  ...communs,
  category_id: uuid.allow(null),
});

// Montant, mode et date exclus : une correction financière passe par l'annulation.
const modificationSchema = Joi.object({
  description: Joi.string().trim().max(500).allow(null, ''),
  category_id: uuid,
  contractor_id: uuid.allow(null),
  apartment_id: uuid.allow(null),
}).min(1);

const listeSchema = Joi.object({
  ...pagination,
  building_id: uuid,
  apartment_id: uuid,
  category_id: uuid,
  contractor_id: uuid,
  work_order_id: uuid,
  method: Joi.string().valid(...codes(MODE_PAIEMENT)),
  status: Joi.string().valid(...codes(STATUT_DEPENSE)),
  du: dateIso,
  au: dateIso,
  tri: tri(['spent_on', 'amount', 'created_at']),
});

const annulationSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
});

// ── Catégories ──────────────────────────────────────────────────────────────
const categorieCreationSchema = Joi.object({
  code: Joi.string().trim().lowercase().pattern(/^[a-z0-9_]{2,40}$/)
    .message('{{#label}} : lettres minuscules, chiffres et « _ » (2 à 40)'),
  name: Joi.string().trim().min(2).max(100).required(),
  cash_group: Joi.string().valid(...codes(GROUPE_CAISSE_SORTIE)).required(),
  sort_order: Joi.number().integer().min(0).max(10000).default(100),
});

const categorieModificationSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100),
  cash_group: Joi.string().valid(...codes(GROUPE_CAISSE_SORTIE)),
  sort_order: Joi.number().integer().min(0).max(10000),
}).min(1);

const categorieListeSchema = Joi.object({
  inclure_inactives: Joi.boolean().default(false),
});

module.exports = {
  creationSchema, depenseTravauxSchema, modificationSchema, listeSchema, annulationSchema,
  categorieCreationSchema, categorieModificationSchema, categorieListeSchema,
};
