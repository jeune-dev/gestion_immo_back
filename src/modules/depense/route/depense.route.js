'use strict';

const router = require('express').Router();
const ctrl = require('../controller/depense.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/depense.validation.js');

// Monté dans l'espace propriétaire (routes.js) : auth + propriétaire + abonnement.
const lire = requirePermission(P.DEPENSES_LIRE);
const ecrire = requirePermission(P.DEPENSES_ECRIRE);
const id = validate(paramId, 'params');

router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
// Idempotency-Key (double clic, reprise réseau) + client_reference (synchronisation hors ligne, § 34).
router.post('/', ecrire, idempotence(), validate(v.creationSchema), ctrl.creer);
router.get('/:id', lire, id, ctrl.detail);
router.patch('/:id', ecrire, id, validate(v.modificationSchema), ctrl.modifier);
router.post('/:id/annuler', ecrire, id, validate(v.annulationSchema), ctrl.annuler);
router.post('/:id/justificatifs', ecrire, id, recevoirFichier('justificatif'), ctrl.justificatif);

module.exports = router;
