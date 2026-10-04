'use strict';

const router = require('express').Router();
const ctrl = require('../controller/immeuble.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/immeuble.validation.js');

// Monté dans l'espace propriétaire (routes.js) : auth + propriétaire + abonnement.
router.get('/', requirePermission(P.PATRIMOINE_LIRE), validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.post('/', requirePermission(P.PATRIMOINE_ECRIRE), validate(v.creationSchema), ctrl.creer);
router.get('/:id', requirePermission(P.PATRIMOINE_LIRE), validate(paramId, 'params'), ctrl.detail);
router.patch('/:id', requirePermission(P.PATRIMOINE_ECRIRE), validate(paramId, 'params'), validate(v.modificationSchema), ctrl.modifier);
router.delete('/:id', requirePermission(P.PATRIMOINE_ECRIRE), validate(paramId, 'params'), ctrl.supprimer);

module.exports = router;
