'use strict';

const router = require('express').Router();
const ctrl = require('../controller/paiement.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/paiement.validation.js');

const lire = requirePermission(P.PAIEMENTS_LIRE);
const id = validate(paramId, 'params');

// Routes à segment fixe AVANT `/:id`.
router.get('/transactions', lire, validate(v.transactionsSchema, 'query'), paginate(), ctrl.transactions);
router.get('/transactions/:id', lire, id, ctrl.transaction);
router.post('/transactions/:id/valider', requirePermission(P.PAIEMENTS_VALIDER), id, idempotence(), ctrl.validerPreuve);
router.post('/transactions/:id/rejeter', requirePermission(P.PAIEMENTS_VALIDER), id, validate(v.rejetSchema), ctrl.rejeterPreuve);

// § 51.3 — file « À rapprocher » et excédents à confirmer.
router.get('/rapprochements', lire, validate(v.rapprochementsSchema, 'query'), paginate(), ctrl.rapprochements);
router.post('/rapprochements/:id/resoudre', requirePermission(P.PAIEMENTS_VALIDER), id, idempotence(), validate(v.resolutionSchema), ctrl.resoudre);
router.post('/rapprochements/:id/rejeter', requirePermission(P.PAIEMENTS_VALIDER), id, validate(v.rejetRapprochementSchema), ctrl.rejeterRapprochement);

// § 51.5 — moyens de paiement du propriétaire.
router.get('/moyens', requirePermission(P.PAIEMENTS_CONFIGURER), ctrl.moyens);
router.put('/moyens', requirePermission(P.PAIEMENTS_CONFIGURER), validate(v.moyenSchema), ctrl.configurerMoyen);

// § 12 — encaissements.
// Mouvements d'argent : Idempotency-Key OBLIGATOIRE (point faible de l'audit) —
// un double envoi (double clic, réseau qui renvoie) n'encaisse ni ne rembourse deux fois.
router.post('/especes', requirePermission(P.PAIEMENTS_ENCAISSER), idempotence({ obligatoire: true }), validate(v.encaissementSchema), ctrl.encaisser);
router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.get('/:id', lire, id, ctrl.detail);
router.get('/:id/quittances', requirePermission(P.QUITTANCES_LIRE), id, ctrl.quittances);
router.post('/:id/rembourser', requirePermission(P.PAIEMENTS_REMBOURSER), id, idempotence({ obligatoire: true }), validate(v.remboursementSchema), ctrl.rembourser);

module.exports = router;
