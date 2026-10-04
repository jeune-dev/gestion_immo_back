'use strict';

/**
 * Catalogue des permissions (RBAC fin, § 32 « contrôle d'accès par rôle »).
 *
 * Les permissions EFFECTIVES d'un rôle vivent en base (`roles.permissions`),
 * semées depuis `PERMISSIONS_PAR_ROLE` ci-dessous. Le catalogue sert :
 *   - au seeder des rôles ;
 *   - à la validation d'une modification de rôle par le super admin (une
 *     permission inconnue est refusée) ;
 *   - aux routes, qui référencent ces constantes plutôt que des chaînes libres.
 *
 * Évolutivité (§ 49) : un rôle `gestionnaire` ou `agence` (V2) sera une ligne
 * de plus dans `roles` avec un sous-ensemble des permissions propriétaire —
 * aucune route ni aucun service à réécrire.
 */

const P = Object.freeze({
  // ── Espace propriétaire ────────────────────────────────────────────────
  DASHBOARD_LIRE: 'dashboard.lire',
  PATRIMOINE_LIRE: 'patrimoine.lire',
  PATRIMOINE_ECRIRE: 'patrimoine.ecrire',
  LOCATAIRES_LIRE: 'locataires.lire',
  LOCATAIRES_ECRIRE: 'locataires.ecrire',
  BAUX_LIRE: 'baux.lire',
  BAUX_ECRIRE: 'baux.ecrire',
  LOYERS_LIRE: 'loyers.lire',
  LOYERS_ECRIRE: 'loyers.ecrire',
  PAIEMENTS_LIRE: 'paiements.lire',
  PAIEMENTS_ENCAISSER: 'paiements.encaisser',
  PAIEMENTS_VALIDER: 'paiements.valider',
  PAIEMENTS_REMBOURSER: 'paiements.rembourser',
  PAIEMENTS_CONFIGURER: 'paiements.configurer',
  QUITTANCES_LIRE: 'quittances.lire',
  CHARGES_LIRE: 'charges.lire',
  CHARGES_ECRIRE: 'charges.ecrire',
  DEPENSES_LIRE: 'depenses.lire',
  DEPENSES_ECRIRE: 'depenses.ecrire',
  CAISSE_LIRE: 'caisse.lire',
  CAISSE_ECRIRE: 'caisse.ecrire',
  TRAVAUX_LIRE: 'travaux.lire',
  TRAVAUX_ECRIRE: 'travaux.ecrire',
  ARTISANS_LIRE: 'artisans.lire',
  ARTISANS_ECRIRE: 'artisans.ecrire',
  INCIDENTS_LIRE: 'incidents.lire',
  INCIDENTS_TRAITER: 'incidents.traiter',
  EDL_LIRE: 'etats_des_lieux.lire',
  EDL_ECRIRE: 'etats_des_lieux.ecrire',
  CAUTIONS_LIRE: 'cautions.lire',
  CAUTIONS_ECRIRE: 'cautions.ecrire',
  MESSAGERIE: 'messagerie.utiliser',
  DOCUMENTS_LIRE: 'documents.lire',
  DOCUMENTS_ECRIRE: 'documents.ecrire',
  RAPPORTS_LIRE: 'rapports.lire',
  ABONNEMENT_GERER: 'abonnement.gerer',
  PARAMETRES_GERER: 'parametres.gerer',

  // ── Espace locataire ───────────────────────────────────────────────────
  LOC_LOGEMENT: 'locataire.logement',
  LOC_PAYER: 'locataire.payer',
  LOC_INCIDENTS: 'locataire.incidents',
  LOC_EDL: 'locataire.etats_des_lieux',
  LOC_CAUTION: 'locataire.caution',
  LOC_MESSAGERIE: 'locataire.messagerie',

  // ── Super admin (web) ──────────────────────────────────────────────────
  ADMIN_DASHBOARD: 'admin.dashboard',
  ADMIN_PROPRIETAIRES: 'admin.proprietaires',
  ADMIN_LOCATAIRES: 'admin.locataires',
  ADMIN_PATRIMOINE: 'admin.patrimoine',
  ADMIN_ABONNEMENTS: 'admin.abonnements',
  ADMIN_PAIEMENTS: 'admin.paiements',
  ADMIN_UTILISATEURS: 'admin.utilisateurs',
  ADMIN_SIGNALEMENTS: 'admin.signalements',
  ADMIN_PARAMETRES: 'admin.parametres',
  ADMIN_NOTIFICATIONS: 'admin.notifications',
  ADMIN_CATEGORIES: 'admin.categories',
  ADMIN_PLANS: 'admin.plans',
  ADMIN_MODELES: 'admin.modeles',
  ADMIN_AUDIT: 'admin.audit',
  ADMIN_ROLES: 'admin.roles',
});

const TOUTES = Object.freeze(Object.values(P));

const PROPRIETAIRE = TOUTES.filter((p) => !p.startsWith('admin.') && !p.startsWith('locataire.'));
const LOCATAIRE = TOUTES.filter((p) => p.startsWith('locataire.'));
const SUPER_ADMIN = TOUTES.filter((p) => p.startsWith('admin.'));

const PERMISSIONS_PAR_ROLE = Object.freeze({
  super_admin: SUPER_ADMIN,
  proprietaire: PROPRIETAIRE,
  locataire: LOCATAIRE,
});

module.exports = { P, TOUTES, PERMISSIONS_PAR_ROLE };
