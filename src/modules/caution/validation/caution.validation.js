'use strict';

const { Joi, uuid, dateIso, montantPositif, montant, tri, pagination } = require('../../../validations/common.js');
const { codes, STATUT_CAUTION, MODE_PAIEMENT, MOTIF_RETENUE } = require('../../../config/enums.js');

const listeSchema = Joi.object({
  ...pagination,
  status: Joi.string().valid(...codes(STATUT_CAUTION)),
  tenant_id: uuid,
  lease_id: uuid,
  detenues: Joi.boolean(),
  tri: tri(['created_at', 'amount_received']),
});

const mouvementSchema = Joi.object({
  amount: montantPositif.required(),
  occurred_on: dateIso.required(),
  method: Joi.string().valid(...codes(MODE_PAIEMENT)).required(),
  reference: Joi.string().trim().max(64).allow('', null),
});

// § 55.3 / § 55.4 — motif ET justificatif obligatoires.
const retenueSchema = Joi.object({
  amount: montantPositif.required(),
  reason: Joi.string().valid(...codes(MOTIF_RETENUE)).required(),
  description: Joi.string().trim().min(5).max(2000).required(),
  justification_document_ids: Joi.array().items(uuid).min(1).max(20).unique().required()
    .messages({ 'array.min': 'Une retenue exige au moins un justificatif' }),
  inspection_item_ids: Joi.array().items(uuid).max(100).unique(),
  occurred_on: dateIso,
});

const reponseSchema = Joi.object({
  response: Joi.string().trim().min(5).max(4000).required(),
  outcome: Joi.string().valid('maintenue', 'annulee', 'ajustee').required(),
  adjusted_amount: montant.when('outcome', { is: 'ajustee', then: Joi.required(), otherwise: Joi.forbidden() }),
});

const contestationSchema = Joi.object({
  message: Joi.string().trim().min(10).max(4000).required(),
});

const paramsRetenue = Joi.object({ id: uuid.required(), transactionId: uuid.required() });
const paramRetenueLocataire = Joi.object({ transactionId: uuid.required() });

module.exports = { listeSchema, mouvementSchema, retenueSchema, reponseSchema, contestationSchema, paramsRetenue, paramRetenueLocataire };
