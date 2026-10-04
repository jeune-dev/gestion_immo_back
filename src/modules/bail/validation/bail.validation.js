'use strict';

const { Joi, uuid, montant, montantPositif, dateIso, tri, pagination } = require('../../../validations/common.js');
const { codes, TYPE_BAIL, PERIODICITE, STATUT_BAIL } = require('../../../config/enums.js');

const champs = {
  lease_type: Joi.string().valid(...codes(TYPE_BAIL)),
  start_date: dateIso,
  end_date: dateIso.allow(null),
  rent_amount: montantPositif,
  charges_amount: montant,
  deposit_amount: montant,
  periodicity: Joi.string().valid(...codes(PERIODICITE)),
  due_day: Joi.number().integer().min(1).max(28),
  occupants_count: Joi.number().integer().min(1).max(50),
  special_conditions: Joi.string().trim().max(10000).allow('', null),
  rent_revision_rule: Joi.string().trim().max(2000).allow('', null),
  notice_period_months: Joi.number().integer().min(0).max(24),
};

const avecDatesCoherentes = (schema) => schema.custom((v, aide) => {
  if (v.end_date && v.start_date && v.end_date <= v.start_date) return aide.message('La date de fin doit être postérieure à la date de début');
  return v;
});

const creationSchema = avecDatesCoherentes(Joi.object({
  ...champs,
  apartment_id: uuid.required(),
  tenant_id: uuid.required(),
  start_date: dateIso.required(),
}));

const modificationSchema = Joi.object(champs).min(1);

const listeSchema = Joi.object({
  ...pagination,
  status: Joi.string().valid(...codes(STATUT_BAIL)),
  tenant_id: uuid,
  apartment_id: uuid,
  building_id: uuid,
  tri: tri(['start_date', 'created_at', 'rent_amount']),
});

const terminaisonSchema = Joi.object({
  ended_on: dateIso.required(),
  termination_reason: Joi.string().trim().max(1000).allow('', null),
});

const annulationSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
});

const loyerSchema = Joi.object({
  rent_amount: montantPositif,
  charges_amount: montant,
  effective_from: dateIso.required(),
}).or('rent_amount', 'charges_amount');

const contratSchema = Joi.object({
  special_clauses: Joi.string().trim().max(10000).allow('', null),
});

module.exports = { creationSchema, modificationSchema, listeSchema, terminaisonSchema, annulationSchema, loyerSchema, contratSchema };
