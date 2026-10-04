'use strict';

const router = require('express').Router();
const ctrl = require('../controller/abonnements.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/admin.validation.js');

// § 30 « Abonnements », « Paiements » ; § 31.
const abonnements = requirePermission(P.ADMIN_ABONNEMENTS);
router.get('/abonnements', abonnements, validate(v.abonnementsSchema, 'query'), paginate(), ctrl.lister);
router.get('/abonnements/:id', abonnements, validate(paramId, 'params'), ctrl.detail);
router.post('/abonnements/:id/suspendre', abonnements, validate(paramId, 'params'), validate(v.motifSchema), ctrl.suspendre);
router.post('/abonnements/:id/reactiver', abonnements, validate(paramId, 'params'), ctrl.reactiver);
router.post('/abonnements/:id/annuler', abonnements, validate(paramId, 'params'), validate(v.motifFacultatifSchema), ctrl.annuler);

const paiements = requirePermission(P.ADMIN_PAIEMENTS);
router.get('/paiements', paiements, validate(v.paiementsSchema, 'query'), paginate(), ctrl.paiements);
router.get('/paiements/loyers/statistiques', paiements, validate(v.statistiquesLoyersSchema, 'query'), ctrl.statistiquesLoyers);

module.exports = router;
