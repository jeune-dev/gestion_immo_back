'use strict';

const router = require('express').Router();
const ctrl = require('../controller/abonnement.controller.js');

// Public (routes.js) : la page de tarifs et l'inscription affichent les
// formules sans compte (§ 31).
router.get('/', ctrl.plansPublics);

module.exports = router;
