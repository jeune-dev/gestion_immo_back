'use strict';

const router = require('express').Router();
const ctrl = require('../controller/messagerie.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const v = require('../validation/messagerie.validation.js');

// Monté dans l'espace locataire (/locataire/messagerie) : auth + requireLocataire
// (req.tenantIds). Chaque fil est chargé par chargerPourLocataire : le fil d'un
// autre locataire répond 403 (§ 54.1, § 56.2).
const utiliser = requirePermission(P.LOC_MESSAGERIE);
const fil = validate(v.paramFil, 'params');

router.get('/', utiliser, validate(v.listeSchema, 'query'), paginate(), ctrl.listerFilsLocataire);
router.get('/:threadId/messages', utiliser, fil, validate(v.listeSchema, 'query'), paginate(), ctrl.messagesFilLocataire);
router.post('/:threadId/messages', utiliser, fil, validate(v.texteSchema), idempotence(), ctrl.envoyerLocataire);
router.post('/:threadId/photos', utiliser, fil, recevoirFichier('image'), validate(v.photoSchema), idempotence(), ctrl.envoyerPhotoLocataire);
router.post('/:threadId/lu', utiliser, fil, ctrl.marquerLuLocataire);

module.exports = router;
