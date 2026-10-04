'use strict';

const router = require('express').Router();
const ctrl = require('../controller/compte.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { mutationRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const v = require('../validation/compte.validation.js');

// Monté après `auth` (routes.js) : tout compte authentifié et actif.
router.get('/', ctrl.profil);
router.patch('/', mutationRateLimit, validate(v.profilSchema), ctrl.modifierProfil);
router.post('/mot-de-passe', mutationRateLimit, validate(v.motDePasseSchema), ctrl.changerMotDePasse);
router.get('/sessions', ctrl.sessions);
router.delete('/sessions/:id', mutationRateLimit, validate(v.sessionIdSchema, 'params'), ctrl.revoquerSession);
router.post('/sessions/revoquer-toutes', mutationRateLimit, ctrl.revoquerToutes);
router.post('/appareils', validate(v.appareilSchema), ctrl.enregistrerAppareil);
// Double authentification TOTP (obligatoire pour le super admin).
router.post('/mfa/initialiser', mutationRateLimit, validate(v.mfaInitialisationSchema), ctrl.initialiserMfa);
router.post('/mfa/activer', mutationRateLimit, validate(v.mfaActivationSchema), ctrl.activerMfa);
router.post('/mfa/desactiver', mutationRateLimit, validate(v.mfaDesactivationSchema), ctrl.desactiverMfa);
router.post('/mfa/codes-secours', mutationRateLimit, validate(v.mfaCodesSecoursSchema), ctrl.codesSecoursMfa);
router.delete('/appareils', validate(v.suppressionAppareilSchema), ctrl.supprimerAppareil);

module.exports = router;
