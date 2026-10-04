'use strict';

const {
  Joi, uuid, email, telephone, nom, montant, dateIso, texteLong, recherche, tri, pagination,
} = require('../../../validations/common.js');
const {
  codes, STATUT_PROPRIETAIRE, STATUT_ABONNEMENT, STATUT_PAIEMENT_ABONNEMENT, STATUT_UTILISATEUR, ROLES,
  STATUT_INCIDENT, CATEGORIE_INCIDENT, GROUPE_CAISSE_SORTIE, PERIODE_FACTURATION, STATUT_PLAN, FONCTIONNALITE,
  TYPE_BAIL, STATUT_MODELE_BAIL,
} = require('../../../config/enums.js');

/**
 * Schémas Joi de l'administration. Toute entrée est bornée ; les statuts
 * ne sont jamais écrits depuis le corps d'une requête (transitions dédiées).
 */

const codePlan = Joi.string().trim().uppercase().max(30);
const motif = Joi.string().trim().min(3).max(1000);

const ownerIdParam = Joi.object({ ownerId: uuid.required() });

// ── Propriétaires, locataires, immeubles, signalements ─────────────────────

const proprietairesSchema = Joi.object({
  ...pagination,
  q: recherche,
  status: Joi.string().valid(...codes(STATUT_PROPRIETAIRE)),
  plan: codePlan,
  abonnement: Joi.string().valid('essai', 'actif', 'suspendu', 'aucun'),
  tri: tri(['created_at', 'display_name']),
});

const motifSchema = Joi.object({ reason: motif.required() });
const motifFacultatifSchema = Joi.object({ reason: motif });

const locatairesSchema = Joi.object({
  ...pagination,
  q: recherche,
  owner_id: uuid,
  tri: tri(['created_at', 'last_name']),
});

const immeublesSchema = Joi.object({
  ...pagination,
  q: recherche,
  owner_id: uuid,
  city: Joi.string().trim().max(100),
  tri: tri(['name', 'city', 'created_at']),
});

const filtresSignalements = {
  status: Joi.string().valid(...codes(STATUT_INCIDENT)),
  category: Joi.string().valid(...codes(CATEGORIE_INCIDENT)),
  owner_id: uuid,
  du: dateIso,
  au: dateIso,
};
const signalementsSchema = Joi.object({ ...pagination, ...filtresSignalements, tri: tri(['created_at', 'status']) });
const statistiquesSignalementsSchema = Joi.object(filtresSignalements);

// ── Abonnements et paiements ───────────────────────────────────────────────

const abonnementsSchema = Joi.object({
  ...pagination,
  status: Joi.string().valid(...codes(STATUT_ABONNEMENT)),
  plan: codePlan,
  owner_id: uuid,
  fin_avant: dateIso,
  tri: tri(['created_at', 'current_period_end']),
});

const activationSchema = Joi.object({
  plan_code: codePlan.required(),
  months: Joi.number().integer().min(1).max(24).required(),
  note: Joi.string().trim().max(1000).allow('', null),
  // Montant réellement encaissé (remise, geste commercial) ; défaut : prix × mois.
  amount: montant.allow(null),
});

const paiementsSchema = Joi.object({
  ...pagination,
  status: Joi.string().valid(...codes(STATUT_PAIEMENT_ABONNEMENT)),
  provider: Joi.string().valid('paydunya', 'manuel'),
  owner_id: uuid,
  du: dateIso,
  au: dateIso,
  tri: tri(['created_at', 'amount']),
});

const statistiquesLoyersSchema = Joi.object({ du: dateIso, au: dateIso });

// ── Utilisateurs ───────────────────────────────────────────────────────────

const utilisateursSchema = Joi.object({
  ...pagination,
  q: recherche,
  role: Joi.string().valid(...codes(ROLES)),
  status: Joi.string().valid(...codes(STATUT_UTILISATEUR)),
  verrouille: Joi.boolean(),
  tri: tri(['created_at', 'last_name', 'last_login_at']),
});

const superAdminSchema = Joi.object({
  first_name: nom.required(),
  last_name: nom.required(),
  email: email.required(),
  phone: telephone.allow(null),
  // Politique renforcée vérifiée par le service (validerMotDePasseAdmin).
  password: Joi.string().max(128).required(),
  // Mot de passe de l'administrateur qui crée le compte (ré-authentification).
  current_password: Joi.string().max(128).required(),
});

const reinitialisationAccesSchema = Joi.object({
  current_password: Joi.string().max(128).required(),
  reason: Joi.string().trim().min(3).max(500).required(),
});

// ── Notifications ──────────────────────────────────────────────────────────

const diffusionSchema = Joi.object({
  cible: Joi.string().valid('proprietaires', 'locataires', 'tous').required(),
  titre: Joi.string().trim().min(3).max(150).required(),
  corps: Joi.string().trim().min(3).max(2000).required(),
});

// ── Catégories ─────────────────────────────────────────────────────────────

const champsCategorie = {
  name: Joi.string().trim().min(1).max(100),
  cash_group: Joi.string().valid(...codes(GROUPE_CAISSE_SORTIE)),
  sort_order: Joi.number().integer().min(0).max(10000),
};
const categorieCreationSchema = Joi.object({
  ...champsCategorie,
  code: Joi.string().trim().lowercase().pattern(/^[a-z][a-z0-9_]{1,39}$/).required()
    .messages({ 'string.pattern.base': '{{#label}} : lettres minuscules, chiffres et _ (2 à 40 caractères)' }),
  name: champsCategorie.name.required(),
  cash_group: champsCategorie.cash_group.required(),
});
const categorieModificationSchema = Joi.object(champsCategorie).min(1);
const categoriesSchema = Joi.object({ is_active: Joi.boolean() });

// ── Plans ──────────────────────────────────────────────────────────────────

const limite = Joi.number().integer().min(1).max(1_000_000).allow(null);
const champsPlan = {
  name: Joi.string().trim().min(1).max(80),
  description: Joi.string().trim().max(2000).allow('', null),
  price: montant,
  currency: Joi.string().trim().uppercase().length(3),
  billing_period: Joi.string().valid(...codes(PERIODE_FACTURATION)),
  max_buildings: limite,
  max_apartments: limite,
  max_whatsapp_per_month: Joi.number().integer().min(0).max(1_000_000).allow(null),
  features: Joi.array().items(Joi.string().valid(...codes(FONCTIONNALITE))).unique().max(codes(FONCTIONNALITE).length),
  sort_order: Joi.number().integer().min(0).max(10000),
};
const planCreationSchema = Joi.object({
  ...champsPlan,
  code: Joi.string().trim().uppercase().pattern(/^[A-Z][A-Z0-9_]{1,29}$/).required()
    .messages({ 'string.pattern.base': '{{#label}} : lettres majuscules, chiffres et _ (2 à 30 caractères)' }),
  name: champsPlan.name.required(),
  price: champsPlan.price.required(),
  status: Joi.string().valid(...codes(STATUT_PLAN)),
});
const planModificationSchema = Joi.object(champsPlan).min(1);
const plansSchema = Joi.object({ status: Joi.string().valid(...codes(STATUT_PLAN)) });

// ── Modèles ────────────────────────────────────────────────────────────────

const corpsModele = Joi.string().min(20).max(200_000);
const modeleBailCreationSchema = Joi.object({
  lease_type: Joi.string().valid(...codes(TYPE_BAIL)).required(),
  title: Joi.string().trim().min(3).max(150).required(),
  body: corpsModele.required(),
  legal_notes: texteLong.allow('', null),
});
const modeleBailModificationSchema = Joi.object({
  title: Joi.string().trim().min(3).max(150),
  body: corpsModele,
  legal_notes: texteLong.allow('', null),
}).min(1);
const modelesBailSchema = Joi.object({
  lease_type: Joi.string().valid(...codes(TYPE_BAIL)),
  status: Joi.string().valid(...codes(STATUT_MODELE_BAIL)),
});

const modeleWhatsappSchema = Joi.object({
  // Nom d'un modèle Meta : minuscules, chiffres et _ uniquement.
  meta_template_name: Joi.string().trim().pattern(/^[a-z0-9_]{1,100}$/)
    .messages({ 'string.pattern.base': '{{#label}} : minuscules, chiffres et _ (nom exact du modèle approuvé par Meta)' }),
  language_code: Joi.string().trim().pattern(/^[a-z]{2,3}(_[A-Z]{2})?$/),
  body_preview: Joi.string().trim().min(1).max(1024),
  variables: Joi.array().items(Joi.string().trim().pattern(/^[a-z_]{1,40}$/)).max(10),
  is_active: Joi.boolean(),
}).min(1);

// ── Journal d'audit ────────────────────────────────────────────────────────

const journalSchema = Joi.object({
  ...pagination,
  owner_id: uuid,
  user_id: uuid,
  action: Joi.string().trim().max(80),
  entity_type: Joi.string().trim().max(40),
  entity_id: Joi.string().trim().max(64),
  du: dateIso,
  au: dateIso,
});

const cleParametre = Joi.object({ cle: Joi.string().trim().max(80).required() });

module.exports = {
  ownerIdParam, proprietairesSchema, motifSchema, motifFacultatifSchema, locatairesSchema, immeublesSchema,
  signalementsSchema, statistiquesSignalementsSchema, abonnementsSchema, activationSchema, paiementsSchema,
  statistiquesLoyersSchema, utilisateursSchema, superAdminSchema, reinitialisationAccesSchema, diffusionSchema,
  categorieCreationSchema, categorieModificationSchema, categoriesSchema,
  planCreationSchema, planModificationSchema, plansSchema,
  modeleBailCreationSchema, modeleBailModificationSchema, modelesBailSchema, modeleWhatsappSchema,
  journalSchema, cleParametre,
};
