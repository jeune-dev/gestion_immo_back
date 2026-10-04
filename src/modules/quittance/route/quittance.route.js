'use strict';

const router = require('express').Router();
const ctrl = require('../controller/quittance.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/quittance.validation.js');

// § 13 — consulter, télécharger, partager.
router.get('/', requirePermission(P.QUITTANCES_LIRE), validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.get('/:id', requirePermission(P.QUITTANCES_LIRE), validate(paramId, 'params'), ctrl.detail);
router.get('/:id/pdf', requirePermission(P.QUITTANCES_LIRE), validate(paramId, 'params'), ctrl.pdf);

module.exports = router;
