'use strict';

const router = require('express').Router();
const ctrl = require('../controller/notification.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/notification.validation.js');

/**
 * Notifications internes (§ 27) — monté pour TOUT compte authentifié
 * (routes.js) : propriétaire, locataire (§ 28 menu « Notifications ») et super
 * admin. Aucune permission : la portée est le compte lui-même (`user_id`),
 * appliquée par le service à chaque requête.
 */
router.get('/', validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.get('/compteur', ctrl.compteur);
router.post('/tout-lire', ctrl.toutLire);
router.post('/:id/lue', validate(paramId, 'params'), ctrl.marquerLue);

module.exports = router;
