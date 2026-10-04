'use strict';

const router = require('express').Router();
const ctrl = require('../controller/utilisateurs.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/admin.validation.js');

// § 30 « Utilisateurs », § 32 comptes actifs / inactifs et déconnexion distante.
const utilisateurs = requirePermission(P.ADMIN_UTILISATEURS);
router.get('/utilisateurs', utilisateurs, validate(v.utilisateursSchema, 'query'), paginate(), ctrl.lister);
router.post('/utilisateurs', utilisateurs, validate(v.superAdminSchema), ctrl.creer);
router.get('/utilisateurs/:id', utilisateurs, validate(paramId, 'params'), ctrl.detail);
router.post('/utilisateurs/:id/desactiver', utilisateurs, validate(paramId, 'params'), validate(v.motifSchema), ctrl.desactiver);
router.post('/utilisateurs/:id/activer', utilisateurs, validate(paramId, 'params'), ctrl.activer);
router.post('/utilisateurs/:id/deverrouiller', utilisateurs, validate(paramId, 'params'), ctrl.deverrouiller);
router.post('/utilisateurs/:id/reinitialiser-acces', utilisateurs, validate(paramId, 'params'), validate(v.reinitialisationAccesSchema), ctrl.reinitialiserAcces);

module.exports = router;
