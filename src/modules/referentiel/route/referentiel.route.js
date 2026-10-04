'use strict';

const router = require('express').Router();
const ctrl = require('../controller/referentiel.controller.js');

// Public (routes.js) : aucune donnée personnelle, uniquement des codes et libellés.
router.get('/', ctrl.lister);

module.exports = router;
