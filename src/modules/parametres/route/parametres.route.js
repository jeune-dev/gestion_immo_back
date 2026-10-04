'use strict';

const router = require('express').Router();
const ctrl = require('../controller/parametres.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const v = require('../validation/parametres.validation.js');

router.get('/', requirePermission(P.DASHBOARD_LIRE), ctrl.lire);
router.patch('/', requirePermission(P.PARAMETRES_GERER), validate(v.reglagesSchema), ctrl.modifierReglages);
router.patch('/profil', requirePermission(P.PARAMETRES_GERER), validate(v.profilSchema), ctrl.modifierProfil);

module.exports = router;
