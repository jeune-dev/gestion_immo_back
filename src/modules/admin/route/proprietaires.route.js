'use strict';

const router = require('express').Router();
const ctrl = require('../controller/proprietaires.controller.js');
const abo = require('../controller/abonnements.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/admin.validation.js');

// § 30 « Propriétaires », « Locataires », « Immeubles », « Signalements ».
const proprietaires = requirePermission(P.ADMIN_PROPRIETAIRES);
router.get('/proprietaires', proprietaires, validate(v.proprietairesSchema, 'query'), paginate(), ctrl.lister);
router.get('/proprietaires/:id', proprietaires, validate(paramId, 'params'), ctrl.detail);
router.post('/proprietaires/:id/suspendre', proprietaires, validate(paramId, 'params'), validate(v.motifSchema), ctrl.suspendre);
router.post('/proprietaires/:id/reactiver', proprietaires, validate(paramId, 'params'), ctrl.reactiver);
// Activation manuelle d'une formule (§ 31) : relève des abonnements.
router.post(
  '/proprietaires/:ownerId/abonnement/activer',
  requirePermission(P.ADMIN_ABONNEMENTS), idempotence(), validate(v.ownerIdParam, 'params'), validate(v.activationSchema), abo.activer
);

router.get('/locataires', requirePermission(P.ADMIN_LOCATAIRES), validate(v.locatairesSchema, 'query'), paginate(), ctrl.locataires);
router.get('/immeubles', requirePermission(P.ADMIN_PATRIMOINE), validate(v.immeublesSchema, 'query'), paginate(), ctrl.immeubles);

const signalements = requirePermission(P.ADMIN_SIGNALEMENTS);
router.get('/signalements', signalements, validate(v.signalementsSchema, 'query'), paginate(), ctrl.signalements);
router.get('/signalements/statistiques', signalements, validate(v.statistiquesSignalementsSchema, 'query'), ctrl.statistiquesSignalements);

module.exports = router;
