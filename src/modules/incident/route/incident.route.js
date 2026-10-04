'use strict';

const router = require('express').Router();
const ctrl = require('../controller/incident.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/incident.validation.js');

// Monté dans l'espace propriétaire (routes.js) : auth + propriétaire + abonnement.
const lire = requirePermission(P.INCIDENTS_LIRE);
const traiter = requirePermission(P.INCIDENTS_TRAITER);
const id = validate(paramId, 'params');

router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.post('/', traiter, idempotence(), validate(v.creationSchema), ctrl.creer);
router.get('/:id', lire, id, ctrl.detail);

// § 23 — workflow (transitions de config/transitions.js#INCIDENT).
router.post('/:id/analyser', traiter, id, validate(v.noteSchema), ctrl.analyser);
router.post('/:id/rejeter', traiter, id, validate(v.rejetSchema), ctrl.rejeter);
router.post('/:id/resoudre', traiter, id, validate(v.noteSchema), ctrl.resoudre);
// § 23 étape 4 — le chantier est aussi une écriture « travaux ».
router.post('/:id/travaux', traiter, requirePermission(P.TRAVAUX_ECRIRE), id, idempotence(), validate(v.travauxSchema), ctrl.creerTravaux);

module.exports = router;
