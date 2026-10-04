'use strict';

const router = require('express').Router();
const ctrl = require('../controller/loyer.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/loyer.validation.js');

// § 11 — échéances (génération automatique : module bail + job quotidien).
router.get('/', requirePermission(P.LOYERS_LIRE), validate(v.listeSchema, 'query'), paginate({ defaut: 30 }), ctrl.lister);
router.get('/:id', requirePermission(P.LOYERS_LIRE), validate(paramId, 'params'), ctrl.detail);
router.post('/:id/annuler', requirePermission(P.LOYERS_ECRIRE), validate(paramId, 'params'), validate(v.annulationSchema), ctrl.annuler);

module.exports = router;
