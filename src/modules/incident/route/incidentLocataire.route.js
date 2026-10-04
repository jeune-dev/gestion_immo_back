'use strict';

const router = require('express').Router();
const ctrl = require('../controller/incident.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/incident.validation.js');

/**
 * Espace locataire — « Signaler un problème » et « Mes demandes » (§ 22, § 28).
 * À monter sous /locataire/incidents, derrière la garde de l'espace locataire
 * (auth → requireLocataire, qui pose req.tenantIds / req.tenantOwners).
 * Chaque requête est bornée aux fiches du compte : jamais la demande d'un
 * autre locataire (403).
 */
const acces = requirePermission(P.LOC_INCIDENTS);
const id = validate(paramId, 'params');

router.get('/', acces, validate(v.listeLocataireSchema, 'query'), paginate(), ctrl.mesDemandes);
router.post('/', acces, idempotence(), validate(v.signalementSchema), ctrl.signaler);
router.get('/:id', acces, id, ctrl.maDemande);
// Photo ou vidéo (multipart, champ `fichier`).
router.post('/:id/pieces', acces, id, recevoirFichier('media'), idempotence(), ctrl.ajouterPiece);

module.exports = router;
