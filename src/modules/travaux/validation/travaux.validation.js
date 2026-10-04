'use strict';

const { Joi, uuid, montant, recherche, tri, pagination } = require('../../../validations/common.js');
const { codes, CATEGORIE_TRAVAUX, PRIORITE, STATUT_TRAVAUX, PHASE_PHOTO } = require('../../../config/enums.js');
// Date existante au calendrier : « 2026-02-30 » ferait échouer PostgreSQL (500).
const { dateReelle: dateIso } = require('../../rapport/validation/rapport.validation.js');

/**
 * Statuts possibles À LA CRÉATION : un travail naît signalé, à valider ou
 * directement validé (propriétaire qui décide lui-même). Les étapes suivantes
 * (artisan assigné, en cours, terminé, annulé) passent obligatoirement par
 * POST /travaux/:id/statut, qui historise chaque transition (§ 41).
 */
const STATUTS_INITIAUX = ['signale', 'a_valider', 'valide'];

const champs = {
  title: Joi.string().trim().min(2).max(150),
  description: Joi.string().trim().max(5000).allow(null, ''),
  apartment_id: uuid.allow(null),
  category: Joi.string().valid(...codes(CATEGORIE_TRAVAUX)),
  priority: Joi.string().valid(...codes(PRIORITE)),
  estimated_amount: montant.allow(null),
  actual_amount: montant.allow(null),
  contractor_id: uuid.allow(null),
  scheduled_for: dateIso.allow(null),
};

const creationSchema = Joi.object({
  ...champs,
  title: champs.title.required(),
  building_id: uuid.required(),
  category: champs.category.required(),
  priority: champs.priority.default('normale'),
  status: Joi.string().valid(...STATUTS_INITIAUX).default('signale'),
});

// L'immeuble ne change pas : dépenses et photos du chantier y sont rattachées.
const modificationSchema = Joi.object(champs).min(1);

const statutSchema = Joi.object({
  status: Joi.string().valid(...codes(STATUT_TRAVAUX)).required(),
  comment: Joi.string().trim().max(2000).allow(null, ''),
  contractor_id: uuid,
  actual_amount: montant,
});

const listeSchema = Joi.object({
  ...pagination,
  q: recherche,
  status: Joi.string().valid(...codes(STATUT_TRAVAUX)),
  priority: Joi.string().valid(...codes(PRIORITE)),
  category: Joi.string().valid(...codes(CATEGORIE_TRAVAUX)),
  building_id: uuid,
  apartment_id: uuid,
  contractor_id: uuid,
  incident_id: uuid,
  du: dateIso,
  au: dateIso,
  tri: tri(['created_at', 'number', 'priority', 'scheduled_for', 'status']),
});

// Champs d'un envoi multipart (valeurs texte converties par Joi).
const photoSchema = Joi.object({
  phase: Joi.string().valid(...codes(PHASE_PHOTO)).required(),
  caption: Joi.string().trim().max(255).allow(null, ''),
  // Horodatage de prise de vue fourni par le mobile (photo prise hors ligne) ;
  // l'horodatage serveur (`created_at`) est conservé à côté.
  captured_at: Joi.date().iso().allow(null, ''),
});

const photoParamsSchema = Joi.object({ id: uuid.required(), photoId: uuid.required() });

module.exports = {
  STATUTS_INITIAUX, creationSchema, modificationSchema, statutSchema, listeSchema, photoSchema, photoParamsSchema,
};
