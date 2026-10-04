'use strict';

const router = require('express').Router();
const ctrl = require('../controller/rapport.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { exigerFonctionnalite } = require('../../../middlewares/abonnement.middleware.js');
const { P } = require('../../../config/permissions.js');
const { rapportRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const v = require('../validation/rapport.validation.js');

// § 26 — rapports, fonctionnalité incluse selon la formule d'abonnement (§ 31).
// Limite dédiée (constat M12) : chaque rapport agrège jusqu'à 36 mois de données.
router.use(rapportRateLimit, requirePermission(P.RAPPORTS_LIRE), exigerFonctionnalite('rapports'));

router.get('/financier', validate(v.rapportSchema, 'query'), ctrl.financier);
router.get('/immobilier', validate(v.rapportSchema, 'query'), ctrl.immobilier);
router.get('/travaux', validate(v.rapportSchema, 'query'), ctrl.travaux);
router.get('/locataires', validate(v.rapportSchema, 'query'), ctrl.locataires);
// § 4 obj. 21, § 48 — rentabilité de chaque appartement, classée.
router.get('/rentabilite', validate(v.rentabiliteSchema, 'query'), paginate({ defaut: 50 }), ctrl.rentabilite);

module.exports = router;
