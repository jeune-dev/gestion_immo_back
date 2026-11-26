'use strict';

const { Joi, email, motDePasse, nom, uuid } = require('../../../validations/common.js');

const profilSchema = Joi.object({
  first_name: nom,
  last_name: nom,
  email: email.allow(null),
  language: Joi.string().valid('fr', 'en'),
  // Exigé par le service quand l'e-mail change (canal de réinitialisation).
  current_password: Joi.string().max(128),
}).or('first_name', 'last_name', 'email', 'language');

const motDePasseSchema = Joi.object({
  current_password: Joi.string().max(128).required(),
  password: motDePasse.required(),
  password_confirmation: Joi.any().valid(Joi.ref('password')).required()
    .messages({ 'any.only': 'La confirmation du mot de passe ne correspond pas' }),
  refresh_token: Joi.string().max(2048).allow('', null),
});

const sessionIdSchema = Joi.object({ id: uuid.required() });

const appareilSchema = Joi.object({
  token: Joi.string().trim().min(10).max(512).required(),
  platform: Joi.string().valid('android', 'ios', 'web').required(),
});

const suppressionAppareilSchema = Joi.object({
  token: Joi.string().trim().min(10).max(512).required(),
});

module.exports = {
  profilSchema, motDePasseSchema, sessionIdSchema, appareilSchema, suppressionAppareilSchema,
};
