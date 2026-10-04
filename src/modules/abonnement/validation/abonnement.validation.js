'use strict';

const { Joi, pagination } = require('../../../validations/common.js');
const { codes, PORTEFEUILLE, STATUT_PAIEMENT_ABONNEMENT } = require('../../../config/enums.js');

const codePlan = Joi.string().trim().uppercase().max(30);

/** Durée payée : 1 à 12 mois par paiement (§ 31). */
const souscriptionSchema = Joi.object({
  plan_code: codePlan.required(),
  months: Joi.number().integer().min(1).max(12).required(),
  wallet: Joi.string().valid(...codes(PORTEFEUILLE)),
});

const paiementsSchema = Joi.object({
  ...pagination,
  status: Joi.string().valid(...codes(STATUT_PAIEMENT_ABONNEMENT)),
});

module.exports = { souscriptionSchema, paiementsSchema, codePlan };
