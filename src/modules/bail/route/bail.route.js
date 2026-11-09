'use strict';

const router = require('express').Router();
const ctrl = require('../controller/bail.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/bail.validation.js');

const lire = requirePermission(P.BAUX_LIRE);
const ecrire = requirePermission(P.BAUX_ECRIRE);
const id = validate(paramId, 'params');

router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.post('/', ecrire, idempotence(), validate(v.creationSchema), ctrl.creer);
router.get('/:id', lire, id, ctrl.detail);
router.patch('/:id', ecrire, id, validate(v.modificationSchema), ctrl.modifier);
router.post('/:id/activer', ecrire, id, ctrl.activer);
router.post('/:id/annuler', ecrire, id, validate(v.annulationSchema), ctrl.annuler);
router.post('/:id/terminer', ecrire, id, validate(v.terminaisonSchema), ctrl.terminer);
router.post('/:id/cloturer', ecrire, id, ctrl.cloturer);
// Accord du locataire avant l'activation : dans son espace, ou bail signé joint.
router.post('/:id/proposer', ecrire, id, ctrl.proposer);
router.post('/:id/acceptation-papier', ecrire, id, recevoirFichier('justificatif'), ctrl.acceptationPapier);
// Nouveau loyer : avenant proposé, appliqué après l'accord du locataire.
router.post('/:id/loyer', ecrire, id, validate(v.loyerSchema), ctrl.proposerAvenant);
router.get('/:id/avenants', lire, id, ctrl.avenants);
router.post('/:id/avenants/:amendmentId/acceptation-papier', ecrire, validate(v.paramAvenant, 'params'), recevoirFichier('justificatif'), ctrl.avenantPapier);
router.post('/:id/avenants/:amendmentId/annuler', ecrire, validate(v.paramAvenant, 'params'), ctrl.annulerAvenant);
// Congé (date de sortie prévue) ; la fin se termine le jour du départ.
router.post('/:id/conge', ecrire, id, validate(v.congeSchema), ctrl.conge);
router.post('/:id/conge/annuler', ecrire, id, ctrl.annulerConge);
// § 53 — contrat généré depuis le modèle publié.
router.get('/:id/contrats', lire, id, ctrl.contrats);
router.post('/:id/contrats', ecrire, id, idempotence(), validate(v.contratSchema), ctrl.genererContrat);

module.exports = router;
