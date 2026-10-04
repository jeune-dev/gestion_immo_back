'use strict';

const router = require('express').Router();
const { rapportRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const ctrl = require('../controller/etatDesLieux.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/etatDesLieux.validation.js');

/**
 * Espace locataire (§ 52.3 étape 3) : consulter, accepter ou contester avec
 * commentaire, dans le délai configurable. Monté sous
 * /api/v1/locataire/etats-des-lieux derrière la garde locataire, qui pose
 * `req.tenantIds` : chaque requête est filtrée sur ces fiches.
 */
const edl = requirePermission(P.LOC_EDL);
const id = validate(paramId, 'params');

router.get('/', edl, validate(v.listeLocataireSchema, 'query'), paginate(), ctrl.listerLocataire);
router.get('/:id', edl, id, ctrl.detailLocataire);
router.get('/:id/pdf', edl, id, rapportRateLimit, ctrl.pdfLocataire);
router.post('/:id/accepter', edl, id, idempotence(), ctrl.accepter);
router.post('/:id/contester', edl, id, idempotence(), validate(v.contestationSchema), ctrl.contester);

module.exports = router;
