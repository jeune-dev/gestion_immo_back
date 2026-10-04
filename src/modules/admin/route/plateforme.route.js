'use strict';

const router = require('express').Router();
const ctrl = require('../controller/plateforme.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { Joi, paramId, pagination } = require('../../../validations/common.js');
const v = require('../validation/admin.validation.js');

// § 30 « Paramètres » — le corps est validé par le schéma propre à la clé (service).
router.get('/parametres', requirePermission(P.ADMIN_PARAMETRES), ctrl.parametres);
router.put('/parametres/:cle', requirePermission(P.ADMIN_PARAMETRES), validate(v.cleParametre, 'params'), ctrl.modifierParametre);

// § 30 « Notifications ».
const notifications = requirePermission(P.ADMIN_NOTIFICATIONS);
router.post('/notifications', notifications, validate(v.diffusionSchema), ctrl.diffuser);
router.get('/notifications', notifications, validate(Joi.object(pagination), 'query'), paginate(), ctrl.diffusions);

// § 30 « Catégories » (catégories de dépenses globales, § 20).
const categories = requirePermission(P.ADMIN_CATEGORIES);
router.get('/categories', categories, validate(v.categoriesSchema, 'query'), ctrl.categories);
router.post('/categories', categories, validate(v.categorieCreationSchema), ctrl.creerCategorie);
router.patch('/categories/:id', categories, validate(paramId, 'params'), validate(v.categorieModificationSchema), ctrl.modifierCategorie);
router.post('/categories/:id/activer', categories, validate(paramId, 'params'), ctrl.activerCategorie);
router.post('/categories/:id/desactiver', categories, validate(paramId, 'params'), ctrl.desactiverCategorie);
router.delete('/categories/:id', categories, validate(paramId, 'params'), ctrl.supprimerCategorie);

// § 40 journal d'audit ; § 32 rôles (lecture seule).
router.get('/journal-audit', requirePermission(P.ADMIN_AUDIT), validate(v.journalSchema, 'query'), paginate(), ctrl.journal);
router.get('/roles', requirePermission(P.ADMIN_ROLES), ctrl.roles);

module.exports = router;
