'use strict';

const router = require('express').Router();
const ctrl = require('../controller/abonnement.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const v = require('../validation/abonnement.validation.js');

// Monté dans l'espace propriétaire (routes.js). La consultation reste possible
// abonnement échu (lecture seule, § 31) ; la souscription est le moyen d'en
// sortir.
router.get('/', requirePermission(P.ABONNEMENT_GERER), ctrl.etat);
router.get('/paiements', requirePermission(P.ABONNEMENT_GERER), validate(v.paiementsSchema, 'query'), paginate(), ctrl.paiements);
// Idempotence : un double clic ne crée pas deux demandes de paiement.
router.post('/souscrire', requirePermission(P.ABONNEMENT_GERER), idempotence(), validate(v.souscriptionSchema), ctrl.souscrire);

module.exports = router;
