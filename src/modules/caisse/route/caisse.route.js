'use strict';

const router = require('express').Router();
const ctrl = require('../controller/caisse.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/caisse.validation.js');

router.get('/', requirePermission(P.CAISSE_LIRE), validate(v.journalSchema, 'query'), paginate({ defaut: 50 }), ctrl.journal);
router.get('/synthese', requirePermission(P.CAISSE_LIRE), validate(v.syntheseSchema, 'query'), ctrl.synthese);
router.post('/autres-revenus', requirePermission(P.CAISSE_ECRIRE), idempotence(), validate(v.autreRevenuSchema), ctrl.autreRevenu);
router.post('/:id/annuler', requirePermission(P.CAISSE_ECRIRE), validate(paramId, 'params'), validate(v.annulationSchema), ctrl.annuler);

module.exports = router;
