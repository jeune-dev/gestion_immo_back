'use strict';

const router = require('express').Router();
const auth = require('./middlewares/auth.middleware.js');
const { requireProprietaire, requireLocataire, requireRole } = require('./middlewares/acces.middleware.js');
const { exigerAbonnementPourEcrire } = require('./middlewares/abonnement.middleware.js');
const { authenticatedRateLimit, adminRateLimit, webhookRateLimit } = require('./middlewares/rateLimit.middleware.js');

/**
 * Registre des routes /api/v1.
 *
 * Trois espaces, trois chaînes de gardes appliquées UNE fois par préfixe —
 * une route ajoutée dans un module hérite automatiquement de la garde de son
 * espace, elle ne peut pas l'oublier :
 *
 *   espace propriétaire : auth → limite par utilisateur → propriétaire actif
 *                         → abonnement (écritures) → permission (dans le module)
 *   espace locataire    : auth → limite → locataire (fiches rattachées)
 *   super admin         : auth → limite admin → rôle super_admin → permission
 */

const espaceProprietaire = [auth, authenticatedRateLimit, requireProprietaire, exigerAbonnementPourEcrire];
const espaceLocataire = [auth, authenticatedRateLimit, requireLocataire];
const espaceAdmin = [auth, adminRateLimit, requireRole('super_admin')];
const authentifie = [auth, authenticatedRateLimit];

const m = (chemin) => require(`./modules/${chemin}`);

// ── Public ─────────────────────────────────────────────────────────────────
router.use('/auth', m('auth/route/auth.route.js'));
router.use('/referentiels', m('referentiel/route/referentiel.route.js'));
router.use('/abonnement/plans', m('abonnement/route/plansPublics.route.js'));
// Webhooks fournisseurs : authentifiés par SIGNATURE, pas par jeton.
router.use('/webhooks', webhookRateLimit, m('webhook/route/webhook.route.js'));

// ── Tout compte authentifié ────────────────────────────────────────────────
router.use('/compte', authentifie, m('compte/route/compte.route.js'));
router.use('/notifications', authentifie, m('notification/route/notification.route.js'));
router.use('/documents', authentifie, m('document/route/document.route.js'));

// ── Espace propriétaire (mobile) ───────────────────────────────────────────
router.use('/dashboard', espaceProprietaire, m('dashboard/route/dashboard.route.js'));
router.use('/immeubles', espaceProprietaire, m('immeuble/route/immeuble.route.js'));
router.use('/appartements', espaceProprietaire, m('appartement/route/appartement.route.js'));
router.use('/locataires', espaceProprietaire, m('locataire/route/locataire.route.js'));
router.use('/baux', espaceProprietaire, m('bail/route/bail.route.js'));
router.use('/echeances', espaceProprietaire, m('loyer/route/loyer.route.js'));
router.use('/paiements', espaceProprietaire, m('paiement/route/paiement.route.js'));
router.use('/quittances', espaceProprietaire, m('quittance/route/quittance.route.js'));
router.use('/factures-communes', espaceProprietaire, m('charge/route/factureCommune.route.js'));
router.use('/charges', espaceProprietaire, m('charge/route/charge.route.js'));
router.use('/depenses', espaceProprietaire, m('depense/route/depense.route.js'));
router.use('/categories-depenses', espaceProprietaire, m('depense/route/categorie.route.js'));
router.use('/caisse', espaceProprietaire, m('caisse/route/caisse.route.js'));
router.use('/travaux', espaceProprietaire, m('travaux/route/travaux.route.js'));
router.use('/artisans', espaceProprietaire, m('artisan/route/artisan.route.js'));
router.use('/incidents', espaceProprietaire, m('incident/route/incident.route.js'));
router.use('/etats-des-lieux', espaceProprietaire, m('etatDesLieux/route/etatDesLieux.route.js'));
router.use('/cautions', espaceProprietaire, m('caution/route/caution.route.js'));
router.use('/messagerie', espaceProprietaire, m('messagerie/route/messagerie.route.js'));
router.use('/rapports', espaceProprietaire, m('rapport/route/rapport.route.js'));
router.use('/parametres', espaceProprietaire, m('parametres/route/parametres.route.js'));
// Abonnement : SANS garde d'abonnement — souscrire est le seul moyen de sortir
// de la lecture seule quand l'abonnement a expiré (§ 31).
router.use('/abonnement', auth, authenticatedRateLimit, requireProprietaire, m('abonnement/route/abonnement.route.js'));

// ── Espace locataire (mobile) ──────────────────────────────────────────────
router.use('/locataire', espaceLocataire, m('espaceLocataire/route/espaceLocataire.route.js'));

// ── Super admin (web) ──────────────────────────────────────────────────────
router.use('/admin', espaceAdmin, m('admin/route/admin.route.js'));

module.exports = router;
