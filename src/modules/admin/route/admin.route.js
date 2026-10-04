'use strict';

const router = require('express').Router();
const tableauDeBord = require('../controller/tableauDeBord.controller.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');

/**
 * Espace Super Admin (§ 29, § 30) — web uniquement.
 *
 * Monté dans routes.js derrière auth + limite admin + rôle super_admin ;
 * chaque route exige EN PLUS sa permission `admin.*` (RBAC fin, § 32) : un
 * futur rôle d'administration restreint (support, comptabilité) sera un
 * sous-ensemble de ces permissions, sans route à réécrire.
 */
router.get('/dashboard', requirePermission(P.ADMIN_DASHBOARD), tableauDeBord.tableauDeBord);
router.use(require('./proprietaires.route.js'));
router.use(require('./abonnements.route.js'));
router.use(require('./utilisateurs.route.js'));
router.use(require('./plateforme.route.js'));
router.use(require('./catalogue.route.js'));

module.exports = router;
