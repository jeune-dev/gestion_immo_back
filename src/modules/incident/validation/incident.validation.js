'use strict';

const { Joi, uuid, montant, recherche, tri, pagination } = require('../../../validations/common.js');
const { codes, CATEGORIE_INCIDENT, STATUT_INCIDENT, CATEGORIE_TRAVAUX, PRIORITE } = require('../../../config/enums.js');
// Date existante au calendrier : « 2026-02-30 » ferait échouer PostgreSQL (500).
const { dateReelle: dateIso } = require('../../rapport/validation/rapport.validation.js');
const { STATUTS_INITIAUX } = require('../../travaux/validation/travaux.validation.js');

const titre = Joi.string().trim().min(2).max(150);
const description = Joi.string().trim().min(2).max(5000);
const note = Joi.string().trim().max(2000).allow(null, '');

/** Incident de partie commune déclaré par le propriétaire. */
const creationSchema = Joi.object({
  building_id: uuid.required(),
  apartment_id: uuid.allow(null),
  category: Joi.string().valid(...codes(CATEGORIE_INCIDENT)).required(),
  title: titre.required(),
  description: description.required(),
});

const listeSchema = Joi.object({
  ...pagination,
  q: recherche,
  status: Joi.string().valid(...codes(STATUT_INCIDENT)),
  category: Joi.string().valid(...codes(CATEGORIE_INCIDENT)),
  building_id: uuid,
  apartment_id: uuid,
  tenant_id: uuid,
  du: dateIso,
  au: dateIso,
  tri: tri(['created_at', 'status', 'reference']),
});

const noteSchema = Joi.object({ note });

const rejetSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(2000).required(),
  note,
});

/** « Créer les travaux depuis l'incident » : tout est facultatif (repris de l'incident). */
const travauxSchema = Joi.object({
  title: titre,
  description: Joi.string().trim().max(5000).allow(null, ''),
  building_id: uuid,
  apartment_id: uuid.allow(null),
  category: Joi.string().valid(...codes(CATEGORIE_TRAVAUX)),
  priority: Joi.string().valid(...codes(PRIORITE)).default('normale'),
  status: Joi.string().valid(...STATUTS_INITIAUX),
  estimated_amount: montant.allow(null),
  contractor_id: uuid.allow(null),
  scheduled_for: dateIso.allow(null),
  note,
});

// ── Espace locataire ────────────────────────────────────────────────────────
const signalementSchema = Joi.object({
  category: Joi.string().valid(...codes(CATEGORIE_INCIDENT)).required(),
  title: titre.required(),
  description: description.required(),
  lease_id: uuid,
  // Référence générée par le mobile pour un signalement fait hors ligne (§ 34).
  client_reference: Joi.string().trim().pattern(/^[A-Za-z0-9_.:-]{8,64}$/)
    .message('{{#label}} doit contenir 8 à 64 caractères alphanumériques'),
});

const listeLocataireSchema = Joi.object({
  ...pagination,
  status: Joi.string().valid(...codes(STATUT_INCIDENT)),
});

module.exports = {
  creationSchema, listeSchema, noteSchema, rejetSchema, travauxSchema, signalementSchema, listeLocataireSchema,
};
