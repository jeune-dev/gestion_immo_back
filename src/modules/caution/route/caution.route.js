'use strict';

const router = require('express').Router();
const ctrl = require('../controller/caution.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/caution.validation.js');

const lire = requirePermission(P.CAUTIONS_LIRE);
const ecrire = requirePermission(P.CAUTIONS_ECRIRE);
const id = validate(paramId, 'params');

// § 55 — cycle de vie de la caution.
router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.get('/:id', lire, id, ctrl.detail);
// Mouvements d'argent : Idempotency-Key OBLIGATOIRE (point faible de l'audit).
router.post('/:id/versements', ecrire, id, idempotence({ obligatoire: true }), validate(v.mouvementSchema), ctrl.verser);
router.post('/:id/justificatifs', ecrire, id, recevoirFichier('justificatif'), idempotence(), ctrl.justificatif);
router.post('/:id/retenues', ecrire, id, idempotence({ obligatoire: true }), validate(v.retenueSchema), ctrl.retenir);
router.post('/:id/restitutions', ecrire, id, idempotence({ obligatoire: true }), validate(v.mouvementSchema), ctrl.restituer);
router.post('/:id/retenues/:transactionId/reponse', ecrire, validate(v.paramsRetenue, 'params'), validate(v.reponseSchema), ctrl.repondre);

module.exports = router;
