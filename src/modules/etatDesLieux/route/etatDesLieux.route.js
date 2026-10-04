'use strict';

const router = require('express').Router();
const { rapportRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const ctrl = require('../controller/etatDesLieux.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/etatDesLieux.validation.js');

// Monté dans l'espace propriétaire (routes.js) : auth + propriétaire + abonnement.
const lire = requirePermission(P.EDL_LIRE);
const ecrire = requirePermission(P.EDL_ECRIRE);
const id = validate(paramId, 'params');
const piece = validate(v.paramPiece, 'params');
const element = validate(v.paramElement, 'params');

router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.post('/', ecrire, idempotence(), validate(v.creationSchema), ctrl.creer);
// § 52.3 étape 5 — avant `/:id` : « comparaison » n'est pas un identifiant.
router.get('/comparaison', lire, validate(v.comparaisonSchema, 'query'), ctrl.comparaison);
router.get('/:id', lire, id, ctrl.detail);
router.patch('/:id', ecrire, id, validate(v.modificationSchema), ctrl.modifier);
router.delete('/:id', ecrire, id, ctrl.supprimer);
// PDF généré à la volée (photos comprises) : limite dédiée (constat M12).
router.get('/:id/pdf', lire, id, rapportRateLimit, ctrl.pdf);

router.post('/:id/pieces', ecrire, id, validate(v.pieceSchema), ctrl.ajouterPiece);
router.patch('/:id/pieces/:roomId', ecrire, piece, validate(v.pieceModificationSchema), ctrl.modifierPiece);
router.delete('/:id/pieces/:roomId', ecrire, piece, ctrl.supprimerPiece);
router.post('/:id/pieces/:roomId/elements', ecrire, piece, validate(v.elementSchema), ctrl.ajouterElement);

router.patch('/:id/elements/:itemId', ecrire, element, validate(v.elementModificationSchema), ctrl.modifierElement);
router.delete('/:id/elements/:itemId', ecrire, element, ctrl.supprimerElement);
// § 52.4 — photo horodatée ; idempotente pour la synchronisation différée (§ 34).
router.post('/:id/elements/:itemId/photos', ecrire, element, recevoirFichier('image'), validate(v.photoSchema), idempotence(), ctrl.ajouterPhoto);
router.delete('/:id/photos/:photoId', ecrire, validate(v.paramPhoto, 'params'), ctrl.supprimerPhoto);

// § 52.4 — saisie hors ligne synchronisée en une requête.
router.put('/:id/saisie', ecrire, id, validate(v.saisieSchema), ctrl.saisie);

router.post('/:id/soumettre', ecrire, id, ctrl.soumettre);
router.post('/:id/corriger', ecrire, id, idempotence(), ctrl.corriger);

module.exports = router;
