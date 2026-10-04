'use strict';

const router = require('express').Router();
const ctrl = require('../controller/dashboard.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const v = require('../validation/dashboard.validation.js');

// § 6, § 48 — tableau de bord du propriétaire (monté dans l'espace propriétaire).
router.get('/', requirePermission(P.DASHBOARD_LIRE), validate(v.tableauDeBordSchema, 'query'), ctrl.tableauDeBord);
router.get('/graphiques', requirePermission(P.DASHBOARD_LIRE), validate(v.graphiquesSchema, 'query'), ctrl.graphiques);

module.exports = router;
