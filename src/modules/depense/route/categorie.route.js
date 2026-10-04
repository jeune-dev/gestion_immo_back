'use strict';

const router = require('express').Router();
const ctrl = require('../controller/categorie.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/depense.validation.js');

// Monté sur /categories-depenses dans l'espace propriétaire (routes.js).
// Liste courte (quelques dizaines de lignes) : pas de pagination.
const lire = requirePermission(P.DEPENSES_LIRE);
const ecrire = requirePermission(P.DEPENSES_ECRIRE);
const id = validate(paramId, 'params');

router.get('/', lire, validate(v.categorieListeSchema, 'query'), ctrl.lister);
router.post('/', ecrire, validate(v.categorieCreationSchema), ctrl.creer);
router.patch('/:id', ecrire, id, validate(v.categorieModificationSchema), ctrl.modifier);
router.post('/:id/desactiver', ecrire, id, ctrl.desactiver);

module.exports = router;
