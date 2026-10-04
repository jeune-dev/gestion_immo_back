'use strict';

const Joi = require('joi');
const { codes, POLITIQUE_EDL_ENTREE, STRATEGIE_ENVOI } = require('./enums.js');

/**
 * Paramètres CONFIGURABLES du cahier des charges.
 *
 * Deux niveaux :
 *   - par propriétaire (`owners.settings`) : délais de relance, politique
 *     d'état des lieux d'entrée, délais de réponse et de restitution… ;
 *   - plateforme (`platform_settings`, super admin) : essai, invitations,
 *     OTP, expiration des paiements.
 *
 * Les valeurs par défaut viennent du cahier des charges quand il en donne
 * (§ 14 : J-3, J0, J+3, J+7, J+15).
 */

const DEFAUTS_PROPRIETAIRE = Object.freeze({
  // § 14 / § 54.2 — délais des relances (jours par rapport à l'échéance).
  reminder_offsets: [-3, 0, 3, 7, 15],
  // Une échéance « à venir » devient « à payer » N jours avant sa date.
  schedule_notice_days: 5,
  // Délai de grâce avant qu'une échéance passe « en retard ».
  late_grace_days: 0,
  // § 52.4 — état des lieux d'entrée requis avant « Occupé » (avertissement bloquant configurable).
  entry_inspection_policy: 'bloquant',
  // § 52.3 — délai laissé au locataire pour accepter ou contester.
  inspection_response_days: 7,
  // § 55.4 — délai de restitution de la caution après la fin du bail.
  deposit_refund_days: 30,
  // § 54.3 — ordre de repli des canaux et stratégie.
  channel_order: ['push', 'whatsapp', 'sms'],
  notification_strategy: 'repli',
});

const schemaParametresProprietaire = Joi.object({
  reminder_offsets: Joi.array().items(Joi.number().integer().min(-30).max(90)).min(1).max(10).unique(),
  schedule_notice_days: Joi.number().integer().min(0).max(30),
  late_grace_days: Joi.number().integer().min(0).max(30),
  entry_inspection_policy: Joi.string().valid(...codes(POLITIQUE_EDL_ENTREE)),
  inspection_response_days: Joi.number().integer().min(1).max(60),
  deposit_refund_days: Joi.number().integer().min(1).max(180),
  channel_order: Joi.array().items(Joi.string().valid('push', 'whatsapp', 'sms')).min(1).max(3).unique(),
  notification_strategy: Joi.string().valid(...codes(STRATEGIE_ENVOI)),
});

/** Paramètres effectifs d'un propriétaire (défauts + surcharges). */
function parametresProprietaire(owner) {
  return { ...DEFAUTS_PROPRIETAIRE, ...(owner?.settings || {}) };
}

const DEFAUTS_PLATEFORME = Object.freeze({
  essai: { plan_code: 'BUSINESS', duree_jours: 14 },
  invitation: { duree_jours: 7 },
  otp: { duree_minutes: 15, tentatives_max: 5 },
  paiement: { expiration_minutes: 30 },
});

const SCHEMAS_PLATEFORME = Object.freeze({
  essai: Joi.object({ plan_code: Joi.string().trim().max(30).required(), duree_jours: Joi.number().integer().min(0).max(90).required() }),
  invitation: Joi.object({ duree_jours: Joi.number().integer().min(1).max(30).required() }),
  otp: Joi.object({ duree_minutes: Joi.number().integer().min(5).max(60).required(), tentatives_max: Joi.number().integer().min(3).max(10).required() }),
  paiement: Joi.object({ expiration_minutes: Joi.number().integer().min(5).max(1440).required() }),
});

module.exports = {
  DEFAUTS_PROPRIETAIRE, schemaParametresProprietaire, parametresProprietaire,
  DEFAUTS_PLATEFORME, SCHEMAS_PLATEFORME,
};
