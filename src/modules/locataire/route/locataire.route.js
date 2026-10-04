'use strict';

const router = require('express').Router();
const ctrl = require('../controller/locataire.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { Joi, paramId } = require('../../../validations/common.js');
const v = require('../validation/locataire.validation.js');

const lire = requirePermission(P.LOCATAIRES_LIRE);
const ecrire = requirePermission(P.LOCATAIRES_ECRIRE);
const id = validate(paramId, 'params');

router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.post('/', ecrire, idempotence(), validate(v.creationSchema), ctrl.creer);
router.get('/:id', lire, id, ctrl.fiche);
router.patch('/:id', ecrire, id, validate(v.modificationSchema), ctrl.modifier);
router.delete('/:id', ecrire, id, ctrl.supprimer);
router.post('/:id/invitation', ecrire, id, ctrl.inviter);
router.post('/:id/consentement-whatsapp', ecrire, id, validate(Joi.object({ accorde: Joi.boolean().required() })), ctrl.consentement);

module.exports = router;
