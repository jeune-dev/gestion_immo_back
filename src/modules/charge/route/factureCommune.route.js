'use strict';

const router = require('express').Router();
const ctrl = require('../controller/factureCommune.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/factureCommune.validation.js');

// § 16–17 — factures communes et répartition. Monté dans l'espace
// propriétaire (routes.js) : auth + propriétaire + abonnement.
const lire = requirePermission(P.CHARGES_LIRE);
const ecrire = requirePermission(P.CHARGES_ECRIRE);
const id = validate(paramId, 'params');

router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
// § 48 « Quelle facture dois-je répartir ? » — déclarée avant /:id.
router.get('/a-repartir', lire, ctrl.aRepartir);
router.post('/', ecrire, idempotence(), validate(v.creationSchema), ctrl.creer);
router.get('/:id', lire, id, ctrl.detail);
router.patch('/:id', ecrire, id, validate(v.modificationSchema), ctrl.modifier);
router.post('/:id/document', ecrire, id, recevoirFichier('justificatif'), ctrl.ajouterDocument);
// Aperçu sans enregistrement (§ 17) : GET (paramètres en requête) ou POST (même corps que /repartir).
router.get('/:id/apercu', lire, id, validate(v.apercuQuerySchema, 'query'), ctrl.apercuQuery);
router.post('/:id/apercu', lire, id, validate(v.repartitionSchema), ctrl.apercuCorps);
router.post('/:id/repartir', ecrire, id, validate(v.repartitionSchema), ctrl.repartir);
router.post('/:id/annuler', ecrire, id, validate(v.annulationSchema), ctrl.annuler);

module.exports = router;
