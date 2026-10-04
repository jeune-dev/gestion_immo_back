'use strict';

const { Joi, telephone, email, motDePasse, nom } = require('../../../validations/common.js');

// § 5 — inscription propriétaire : prénom, nom, téléphone, email, mot de passe, confirmation.
const inscriptionSchema = Joi.object({
  first_name: nom.required(),
  last_name: nom.required(),
  phone: telephone.required(),
  email: email.required(),
  password: motDePasse.required(),
  password_confirmation: Joi.any().valid(Joi.ref('password')).required()
    .messages({ 'any.only': 'La confirmation du mot de passe ne correspond pas' }),
  company_name: Joi.string().trim().max(150).allow('', null),
  city: Joi.string().trim().max(100).allow('', null),
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

// § 5 — mot de passe oublié (code à 6 chiffres envoyé par e-mail).
const motDePasseOublieSchema = Joi.object({
  identifiant: Joi.string().trim().max(254).required(),
});

const reinitialisationSchema = Joi.object({
  identifiant: Joi.string().trim().max(254).required(),
  code: Joi.string().trim().pattern(/^\d{6}$/).required().messages({ 'string.pattern.base': 'Le code doit contenir 6 chiffres' }),
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

// Double authentification — seconde étape de la connexion.
const codeTotp = Joi.string().trim().pattern(/^\d{6}$/).messages({ 'string.pattern.base': 'Le code de vérification contient 6 chiffres' });
const codeSecours = Joi.string().trim().max(20);

const mfaSchema = Joi.object({
  mfa_token: Joi.string().max(2048).required(),
  code: codeTotp,
  code_secours: codeSecours,
  device_name: Joi.string().trim().max(120).allow('', null),
  platform: Joi.string().valid('android', 'ios', 'web').allow(null),
}).xor('code', 'code_secours').messages({ 'object.xor': 'Fournissez soit le code de vérification, soit un code de secours' });

module.exports = {
  inscriptionSchema, connexionSchema, refreshSchema, deconnexionSchema,
  motDePasseOublieSchema, reinitialisationSchema, activationSchema, mfaSchema, codeTotp, codeSecours,
};
