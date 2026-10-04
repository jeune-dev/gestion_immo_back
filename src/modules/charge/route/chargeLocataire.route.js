'use strict';

const router = require('express').Router();
const ctrl = require('../controller/charge.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/charge.validation.js');

// § 28 « Mes charges » — à monter sous /locataire/charges dans l'espace
// locataire (auth → requireLocataire, qui pose req.tenantIds). Chaque requête
// filtre sur req.tenantIds : jamais la charge d'un autre locataire.
router.get('/', requirePermission(P.LOC_LOGEMENT), validate(v.listeLocataireSchema, 'query'), paginate(), ctrl.listerLocataire);
router.get('/:id', requirePermission(P.LOC_LOGEMENT), validate(paramId, 'params'), ctrl.detailLocataire);

module.exports = router;
