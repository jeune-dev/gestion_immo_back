'use strict';

const router = require('express').Router();
const ctrl = require('../controller/auth.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { authRateLimit, sessionRateLimit, otpCibleRateLimit, motDePasseOublieRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const v = require('../validation/auth.validation.js');
const { limiteActivation } = require('./limiteActivation.js');
const auth = require('../../../middlewares/auth.middleware.js');

// § 5 — Authentification. Routes publiques, toutes limitées en débit.
// Inscription en deux temps : le code part à l'adresse (étape 1), il est
// vérifié (étape 2), et le compte n'est créé qu'ensuite, sur présentation du
// jeton rendu par l'étape 2. L'envoi est borné par IP ET par adresse visée,
// comme « mot de passe oublié » : sans cela, l'adresse d'un tiers pourrait
// être inondée d'e-mails.
router.post('/inscription/code', motDePasseOublieRateLimit, otpCibleRateLimit, validate(v.inscriptionCodeSchema), ctrl.inscriptionCode);
router.post('/inscription/verifier-code', authRateLimit, validate(v.inscriptionVerificationSchema), ctrl.inscriptionVerifierCode);
router.post('/inscription', authRateLimit, validate(v.inscriptionSchema), ctrl.inscription);
// Portail KODAFRIK : le compte est-il un administrateur de Terangaloc ?
router.post('/localiser', authRateLimit, validate(v.localiserSchema), ctrl.localiser);
router.post('/connexion', authRateLimit, validate(v.connexionSchema), ctrl.connexion);
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
// Code d'accès à quatre chiffres du super admin (portail KODAFRIK), sur sa
// session ouverte. Les échecs comptent dans la limite par IP ; le service
// bloque le compte 15 min au cinquième.
router.post('/code-acces/verifier', authRateLimit, auth, validate(v.codeAccesSchema), ctrl.verifierCodeAcces);

module.exports = router;
