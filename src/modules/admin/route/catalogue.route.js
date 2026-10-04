'use strict';

const router = require('express').Router();
const plans = require('../controller/plans.controller.js');
const modeles = require('../controller/modeles.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/admin.validation.js');

// § 30 « Plans tarifaires », § 31 : prix configurables, jamais codés en dur.
const p = requirePermission(P.ADMIN_PLANS);
router.get('/plans', p, validate(v.plansSchema, 'query'), plans.lister);
router.post('/plans', p, validate(v.planCreationSchema), plans.creer);
router.get('/plans/:id', p, validate(paramId, 'params'), plans.detail);
router.patch('/plans/:id', p, validate(paramId, 'params'), validate(v.planModificationSchema), plans.modifier);
router.post('/plans/:id/activer', p, validate(paramId, 'params'), plans.activer);
router.post('/plans/:id/desactiver', p, validate(paramId, 'params'), plans.desactiver);
router.delete('/plans/:id', p, validate(paramId, 'params'), plans.supprimer);

// § 53.4 modèles de bail versionnés ; § 54.3 modèles WhatsApp.
const m = requirePermission(P.ADMIN_MODELES);
router.get('/modeles-bail', m, validate(v.modelesBailSchema, 'query'), modeles.listerBaux);
router.get('/modeles-bail/variables', m, modeles.variables);
router.post('/modeles-bail', m, validate(v.modeleBailCreationSchema), modeles.creerBail);
router.get('/modeles-bail/:id', m, validate(paramId, 'params'), modeles.detailBail);
router.patch('/modeles-bail/:id', m, validate(paramId, 'params'), validate(v.modeleBailModificationSchema), modeles.modifierBail);
router.post('/modeles-bail/:id/publier', m, validate(paramId, 'params'), modeles.publierBail);
router.post('/modeles-bail/:id/archiver', m, validate(paramId, 'params'), modeles.archiverBail);

router.get('/modeles-whatsapp', m, modeles.listerWhatsapp);
router.patch('/modeles-whatsapp/:id', m, validate(paramId, 'params'), validate(v.modeleWhatsappSchema), modeles.modifierWhatsapp);

module.exports = router;
