'use strict';

const router = require('express').Router();
const ctrl = require('../controller/messagerie.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { exigerFonctionnalite } = require('../../../middlewares/abonnement.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/messagerie.validation.js');

// Monté dans l'espace propriétaire (routes.js) : auth + propriétaire + abonnement.
// Envoyer exige en plus que la messagerie soit incluse dans la formule (§ 31) ;
// relire l'historique reste toujours possible (§ 54.1 « historique conservé »).
const utiliser = requirePermission(P.MESSAGERIE);
const fonctionnalite = exigerFonctionnalite('messagerie');
const id = validate(paramId, 'params');
const locataire = validate(v.paramLocataire, 'params');
const liste = [validate(v.listeSchema, 'query'), paginate()];

router.get('/fils', utiliser, ...liste, ctrl.listerFils);
router.get('/fils/:id/messages', utiliser, id, ...liste, ctrl.messagesFil);
router.post('/fils/:id/lu', utiliser, id, ctrl.marquerLu);
router.post('/locataires/:tenantId/messages', utiliser, fonctionnalite, locataire, validate(v.texteSchema), idempotence(), ctrl.envoyer);
router.post('/locataires/:tenantId/photos', utiliser, fonctionnalite, locataire, recevoirFichier('image'), validate(v.photoSchema), idempotence(), ctrl.envoyerPhoto);

module.exports = router;
