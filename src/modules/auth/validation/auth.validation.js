'use strict';

const { Joi, telephone, email, motDePasse, nom } = require('../../../validations/common.js');

// § 5 — inscription en deux temps. Étape 1 : l'adresse seule, pour recevoir
// le code. Le prénom n'est là que pour l'e-mail (« Bonjour Awa ») : il est
// facultatif, l'adresse suffit.
const inscriptionCodeSchema = Joi.object({
  email: email.required(),
  first_name: nom.allow('', null),
});

// Étape 2 : le code à 6 chiffres, espaces et tirets indifférents.
const codeInscription = Joi.string().replace(/[\s-]+/g, '').pattern(/^[0-9]{6}$/).required()
  .messages({ 'string.pattern.base': 'Le code contient 6 chiffres' });

const inscriptionVerificationSchema = Joi.object({
  email: email.required(),
  code: codeInscription,
});

// § 5 — inscription propriétaire : prénom, nom, téléphone, email, mot de passe, confirmation.
const inscriptionSchema = Joi.object({
  first_name: nom.required(),
  last_name: nom.required(),
  // Facultatif : l'adresse e-mail suffit à identifier un propriétaire, et
  // l'App Store refuse qu'on exige une donnée dont le service n'a pas besoin
  // (règle 5.1.1(v)). Fourni, le numéro reste contrôlé et unique.
  phone: telephone.allow('', null),
  email: email.required(),
  password: motDePasse.required(),
  password_confirmation: Joi.any().valid(Joi.ref('password')).required()
    .messages({ 'any.only': 'La confirmation du mot de passe ne correspond pas' }),
  company_name: Joi.string().trim().max(150).allow('', null),
  city: Joi.string().trim().max(100).allow('', null),
  // Preuve que l'adresse a été vérifiée (étape 2). Exigée par le service
  // selon `INSCRIPTION_VERIFICATION_EMAIL`, et non ici : une ancienne version
  // de l'application, qui ne l'envoie pas, doit recevoir un message clair
  // plutôt qu'une erreur de validation sur un champ qu'elle ne connaît pas.
  email_token: Joi.string().max(1024).allow('', null),
});

// § 5 — connexion par téléphone OU email.
const connexionSchema = Joi.object({
  // Borné : une chaîne géante n'atteint jamais la détection e-mail/téléphone.
  identifiant: Joi.string().trim().max(254).required(),
  password: Joi.string().max(128).required(),
  device_name: Joi.string().trim().max(120).allow('', null),
  platform: Joi.string().valid('android', 'ios', 'web').allow(null),
});

const refreshSchema = Joi.object({
  refresh_token: Joi.string().max(2048).allow('', null),
});

const deconnexionSchema = refreshSchema;

// § 5 — mot de passe oublié, en trois étapes (comme Yobante) : demande du
// code → vérification du code → nouveau mot de passe. Code de 8 caractères
// (lettres et chiffres) envoyé par e-mail ; casse et espaces indifférents.
const motDePasseOublieSchema = Joi.object({
  identifiant: Joi.string().trim().max(254).required(),
});

const codeReinitialisation = Joi.string().replace(/\s+/g, '').uppercase().pattern(/^[A-Z0-9]{8}$/).required()
  .messages({ 'string.pattern.base': 'Le code contient 8 caractères (lettres et chiffres)' });

const verificationCodeSchema = Joi.object({
  identifiant: Joi.string().trim().max(254).required(),
  code: codeReinitialisation,
});

const reinitialisationSchema = Joi.object({
  identifiant: Joi.string().trim().max(254).required(),
  code: codeReinitialisation,
  password: motDePasse.required(),
  password_confirmation: Joi.any().valid(Joi.ref('password')).required()
    .messages({ 'any.only': 'La confirmation du mot de passe ne correspond pas' }),
});

// § 5 option B — activation du compte locataire par code (+ téléphone) ou par lien.
const activationSchema = Joi.object({
  token: Joi.string().trim().max(200),
  code: Joi.string().trim().pattern(/^\d{8}$/).messages({ 'string.pattern.base': "Le code d'activation contient 8 chiffres" }),
  phone: telephone,
  password: motDePasse.required(),
  password_confirmation: Joi.any().valid(Joi.ref('password')).required()
    .messages({ 'any.only': 'La confirmation du mot de passe ne correspond pas' }),
  device_name: Joi.string().trim().max(120).allow('', null),
  platform: Joi.string().valid('android', 'ios', 'web').allow(null),
})
  .xor('token', 'code')
  .with('code', 'phone')
  .messages({ 'object.xor': "Fournissez soit le lien d'activation, soit le code d'activation" });

// Code d'accès à quatre chiffres du super admin (portail KODAFRIK).
const codeAccesSchema = Joi.object({
  code: Joi.string().pattern(/^\d{4}$/).required().messages({ 'string.pattern.base': "Le code d'accès fait exactement quatre chiffres." }),
});

module.exports = {
  codeAccesSchema,
  inscriptionSchema, connexionSchema, refreshSchema, deconnexionSchema,
  inscriptionCodeSchema, inscriptionVerificationSchema,
  motDePasseOublieSchema, verificationCodeSchema, reinitialisationSchema, activationSchema,
};
