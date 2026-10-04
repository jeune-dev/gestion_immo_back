'use strict';

const router = require('express').Router();
const ctrl = require('../controller/appartement.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/appartement.validation.js');

const lire = requirePermission(P.PATRIMOINE_LIRE);
const ecrire = requirePermission(P.PATRIMOINE_ECRIRE);
const id = validate(paramId, 'params');

router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.post('/', ecrire, validate(v.creationSchema), ctrl.creer);
router.get('/:id', lire, id, ctrl.detail);
router.patch('/:id', ecrire, id, validate(v.modificationSchema), ctrl.modifier);
router.patch('/:id/statut', ecrire, id, validate(v.statutSchema), ctrl.changerStatut);
router.delete('/:id', ecrire, id, ctrl.supprimer);
router.get('/:id/historique', lire, id, validate(v.historiqueSchema, 'query'), paginate({ defaut: 30 }), ctrl.historique);
router.get('/:id/rentabilite', requirePermission(P.RAPPORTS_LIRE), id, validate(v.rentabiliteSchema, 'query'), ctrl.rentabilite);

module.exports = router;
