'use strict';

const router = require('express').Router();
const ctrl = require('../controller/artisan.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/artisan.validation.js');

// Monté dans l'espace propriétaire (routes.js) : auth + propriétaire + abonnement.
const lire = requirePermission(P.ARTISANS_LIRE);
const ecrire = requirePermission(P.ARTISANS_ECRIRE);
const id = validate(paramId, 'params');

router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.post('/', ecrire, idempotence(), validate(v.creationSchema), ctrl.creer);
router.get('/:id', lire, id, ctrl.detail);
router.patch('/:id', ecrire, id, validate(v.modificationSchema), ctrl.modifier);
router.post('/:id/desactiver', ecrire, id, ctrl.desactiver);
router.post('/:id/reactiver', ecrire, id, ctrl.reactiver);
router.delete('/:id', ecrire, id, ctrl.supprimer);

module.exports = router;
