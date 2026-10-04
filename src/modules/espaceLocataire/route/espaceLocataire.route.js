'use strict';

const router = require('express').Router();
const ctrl = require('../controller/espaceLocataire.controller.js');
const quittances = require('../../quittance/controller/quittance.controller.js');
const cautions = require('../../caution/controller/caution.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission } = require('../../../middlewares/acces.middleware.js');
const { paiementRateLimit } = require('../../../middlewares/rateLimit.middleware.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('./../validation/espaceLocataire.validation.js');
const vp = require('../../paiement/validation/paiement.validation.js');
const vq = require('../../quittance/validation/quittance.validation.js');
const vc = require('../../caution/validation/caution.validation.js');

/**
 * Espace locataire (§ 28) — monté par routes.js derrière `requireLocataire`
 * (req.tenantIds). Menu : Accueil · Mon logement · Mon loyer · Mes charges ·
 * Mes paiements · Mes quittances · Signaler un problème · Mes demandes ·
 * Notifications (/api/v1/notifications) · Profil (/api/v1/compte).
 */

const logement = requirePermission(P.LOC_LOGEMENT);
const payer = requirePermission(P.LOC_PAYER);
const id = validate(paramId, 'params');

router.get('/accueil', logement, ctrl.accueil);
router.get('/logement', logement, ctrl.logement);

// Mon loyer.
router.get('/echeances', logement, validate(v.echeancesSchema, 'query'), paginate(), ctrl.echeances);
router.get('/echeances/:id', logement, id, ctrl.echeance);

// Mes paiements (§ 12, § 51) — le paiement n'est jamais possible hors ligne :
// toute confirmation vient du serveur.
router.get('/paiements/moyens', payer, validate(vp.moyensLocataireSchema, 'query'), ctrl.moyens);
router.get('/paiements', logement, validate(v.paginationSchema, 'query'), paginate(), ctrl.paiements);
router.get('/paiements/transactions', payer, validate(v.paginationSchema, 'query'), paginate(), ctrl.transactions);
router.get('/paiements/transactions/:id', payer, id, ctrl.transaction);
router.post('/paiements', payer, paiementRateLimit, idempotence({ obligatoire: true }), validate(vp.initiationSchema), ctrl.initier);
router.post('/paiements/preuves', payer, paiementRateLimit, recevoirFichier('justificatif', { obligatoire: false }), validate(vp.preuveSchema), idempotence(), ctrl.preuve);

// Mes quittances (§ 13).
router.get('/quittances', logement, validate(vq.listeSchema, 'query'), paginate(), quittances.listerLocataire);
router.get('/quittances/:id', logement, id, quittances.detailLocataire);
router.get('/quittances/:id/pdf', logement, id, quittances.pdfLocataire);

// Caution (§ 55) : consultation et contestation d'une retenue.
router.get('/caution', requirePermission(P.LOC_CAUTION), cautions.listerLocataire);
router.post('/caution/retenues/:transactionId/contester', requirePermission(P.LOC_CAUTION), validate(vc.paramRetenueLocataire, 'params'), validate(vc.contestationSchema), cautions.contester);

// Modules métier qui exposent leur propre routeur locataire.
router.use('/charges', require('../../charge/route/chargeLocataire.route.js'));
router.use('/incidents', require('../../incident/route/incidentLocataire.route.js'));
router.use('/etats-des-lieux', require('../../etatDesLieux/route/etatDesLieuxLocataire.route.js'));
router.use('/messagerie', require('../../messagerie/route/messagerieLocataire.route.js'));

// Consentement WhatsApp (§ 54.3).
router.post('/consentement-whatsapp', logement, validate(v.consentementSchema), ctrl.consentement);

module.exports = router;
