'use strict';

const router = require('express').Router();
const ctrl = require('../controller/document.controller.js');
const validate = require('../../../middlewares/validate.middleware.js');
const paginate = require('../../../middlewares/pagination.middleware.js');
const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requirePermission, requireProprietaire, requireLocataire } = require('../../../middlewares/acces.middleware.js');
const { exigerAbonnementPourEcrire } = require('../../../middlewares/abonnement.middleware.js');
const { ForbiddenError } = require('../../../errors/AppError.js');
const { P } = require('../../../config/permissions.js');
const { paramId } = require('../../../validations/common.js');
const v = require('../validation/document.validation.js');

/**
 * Documents (§ 7, § 9, § 10, § 37 « URL sécurisée », § 38 stockage objet).
 *
 * Monté pour TOUT compte authentifié (routes.js) : le même document peut être
 * lu par le propriétaire ET par le locataire concerné. L'espace de l'appelant
 * est donc établi ici :
 *   - locataire : ses fiches `tenants` (requireLocataire → req.tenantIds) ;
 *   - propriétaire : espace actif (requireProprietaire → req.ownerId) ;
 *   - super admin : refusé — aucun accès aux fichiers privés des
 *     propriétaires (minimisation, cf. documents.verifierAcces).
 */
const espace = (req, res, next) => (req.user.role_code === 'locataire'
  ? requireLocataire(req, res, next)
  : requireProprietaire(req, res, next));

/** Lecture : `documents.lire` (propriétaire) ou `locataire.logement` (§ 28). */
const lire = (req, res, next) => requirePermission(req.tenantIds ? P.LOC_LOGEMENT : P.DOCUMENTS_LIRE)(req, res, next);

/**
 * Écriture : propriétaire uniquement, abonnement actif (§ 31 — espace en
 * lecture seule sinon), permission `documents.ecrire`.
 */
const proprietaireSeulement = (req, res, next) => (req.tenantIds
  ? next(new ForbiddenError('Cette action est réservée au propriétaire.', 'ESPACE_PROPRIETAIRE_REQUIS'))
  : next());
const ecrire = [proprietaireSeulement, exigerAbonnementPourEcrire, requirePermission(P.DOCUMENTS_ECRIRE)];

const id = validate(paramId, 'params');

router.use(espace);

router.post('/', ...ecrire, recevoirFichier('document'), validate(v.televersementSchema), idempotence(), ctrl.televerser);
router.get('/', lire, validate(v.listeSchema, 'query'), paginate(), ctrl.lister);
router.get('/:id/fichier', lire, id, validate(v.fichierSchema, 'query'), ctrl.fichier);
router.get('/:id/lien', lire, id, validate(v.fichierSchema, 'query'), ctrl.lien);
router.patch('/:id', ...ecrire, id, validate(v.modificationSchema), ctrl.modifier);
router.delete('/:id', ...ecrire, id, ctrl.supprimer);

module.exports = router;
