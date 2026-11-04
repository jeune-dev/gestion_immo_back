'use strict';

const router = require('express').Router();
const ctrl = require('../controller/auth.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { authRateLimit, sessionRateLimit, otpCibleRateLimit, motDePasseOublieRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const v = require('../validation/auth.validation.js');
const { limiteActivation } = require('./limiteActivation.js');

// § 5 — Authentification. Routes publiques, toutes limitées en débit.
router.post('/inscription', authRateLimit, validate(v.inscriptionSchema), ctrl.inscription);
router.post('/connexion', authRateLimit, validate(v.connexionSchema), ctrl.connexion);
// Seconde étape de la connexion quand la double authentification est active.
router.post('/mfa', authRateLimit, validate(v.mfaSchema), ctrl.mfa);
router.post('/refresh', sessionRateLimit, validate(v.refreshSchema), ctrl.rafraichir);
router.post('/deconnexion', sessionRateLimit, validate(v.deconnexionSchema), ctrl.deconnexion);
// Mot de passe oublié en trois étapes. Demande : bornée par IP et par compte
// visé (anti-spam d'e-mails). Vérification et réinitialisation : chaque code
// a son propre plafond d'essais (auth.service), et les échecs comptent dans
// la limite par IP.
router.post('/mot-de-passe-oublie', motDePasseOublieRateLimit, otpCibleRateLimit, validate(v.motDePasseOublieSchema), ctrl.motDePasseOublie);
router.post('/verifier-code', authRateLimit, validate(v.verificationCodeSchema), ctrl.verifierCode);
router.post('/reinitialiser-mot-de-passe', authRateLimit, validate(v.reinitialisationSchema), ctrl.reinitialiser);
// § 5 option B — activation du compte locataire (lien ou code d'invitation).
// Limité par IP ET par téléphone ciblé (force brute du code à 8 chiffres).
router.post('/locataire/activation', authRateLimit, limiteActivation, validate(v.activationSchema), ctrl.activerLocataire);

module.exports = router;
