'use strict';

const { Joi, uuid, montantPositif, pagination } = require('../../../validations/common.js');
const { codes, CATEGORIE_CAISSE, MODE_PAIEMENT, SENS_CAISSE } = require('../../../config/enums.js');
// Date existante au calendrier : « 2026-02-30 » ferait échouer PostgreSQL (500).
const { dateReelle: dateIso } = require('../../rapport/validation/rapport.validation.js');

const journalSchema = Joi.object({
  ...pagination,
  du: dateIso,
  au: dateIso,
  building_id: uuid,
  direction: Joi.string().valid(...codes(SENS_CAISSE)),
  category: Joi.string().valid(...codes(CATEGORIE_CAISSE)),
  method: Joi.string().valid(...codes(MODE_PAIEMENT)),
  inclure_cautions: Joi.boolean().default(false),
});

/** Synthèse d'une période (§ 21) : une période inversée est une erreur, pas une caisse vide. */
const syntheseSchema = Joi.object({
  du: dateIso.required(),
  au: dateIso.required(),
  building_id: uuid,
}).custom((v, aide) => (v.au < v.du ? aide.message('"au" doit être postérieur ou égal à "du"') : v));

const autreRevenuSchema = Joi.object({
  amount: montantPositif.required(),
  method: Joi.string().valid(...codes(MODE_PAIEMENT)).required(),
  occurred_on: dateIso.required(),
  label: Joi.string().trim().min(2).max(200).required(),
  building_id: uuid.allow(null),
  apartment_id: uuid.allow(null),
});

const annulationSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
});

module.exports = { journalSchema, syntheseSchema, autreRevenuSchema, annulationSchema };
