'use strict';

const router = require('express').Router();
const ctrl = require('../controller/travaux.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/travaux.validation.js');
const vDepense = require('../../depense/validation/depense.validation.js');

// Monté dans l'espace propriétaire (routes.js) : auth + propriétaire + abonnement.
const lire = requirePermission(P.TRAVAUX_LIRE);
const ecrire = requirePermission(P.TRAVAUX_ECRIRE);
const id = validate(paramId, 'params');

router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.post('/', ecrire, idempotence(), validate(v.creationSchema), ctrl.creer);
router.get('/:id', lire, id, ctrl.detail);
router.patch('/:id', ecrire, id, validate(v.modificationSchema), ctrl.modifier);
router.post('/:id/statut', ecrire, id, validate(v.statutSchema), ctrl.statut);

// § 19 — photos avant / pendant / après (multipart : champ `fichier` + phase, caption, captured_at).
router.get('/:id/photos', lire, id, ctrl.photos);
router.post('/:id/photos', ecrire, id, recevoirFichier('image'), validate(v.photoSchema), idempotence(), ctrl.ajouterPhoto);
router.delete('/:id/photos/:photoId', ecrire, validate(v.photoParamsSchema, 'params'), ctrl.supprimerPhoto);

// § 23 étape 7 — dépense du chantier : écriture financière, permission « dépenses ».
router.post('/:id/depenses', requirePermission(P.DEPENSES_ECRIRE), id, idempotence(), validate(vDepense.depenseTravauxSchema), ctrl.depense);

module.exports = router;
