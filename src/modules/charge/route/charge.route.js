'use strict';

const router = require('express').Router();
const ctrl = require('../controller/charge.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/charge.validation.js');

// § 15–16 — charges refacturées aux locataires (création : répartition d'une
// facture commune ; encaissement : module paiement).
router.get('/', requirePermission(P.CHARGES_LIRE), validate(v.listeSchema, 'query'), paginate({ defaut: 30 }), ctrl.lister);
router.get('/:id', requirePermission(P.CHARGES_LIRE), validate(paramId, 'params'), ctrl.detail);

module.exports = router;
