'use strict';

const cron = require('node-cron');
const { executerJob } = require('./executerJob.js');
const { FUSEAU } = require('../utils/dates.js');
const echeances = require('../modules/loyer/service/echeance.service.js');
const relances = require('../modules/loyer/service/relance.service.js');
const paiementsLocataire = require('../modules/paiement/service/paiementLocataire.service.js');
const cautions = require('../modules/caution/service/caution.service.js');
const charges = require('../modules/charge/service/charge.service.js');
const etatsDesLieux = require('../modules/etatDesLieux/service/etatDesLieux.service.js');
const abonnements = require('../modules/abonnement/service/abonnement.service.js');
const quittances = require('../modules/quittance/service/quittance.service.js');
const { nettoyer } = require('./nettoyage.js');

/**
 * Tâches planifiées — démarrées par le seul worker leader (server.js),
 * chacune protégée par un verrou consultatif PostgreSQL (executerJob).
 * Heures exprimées dans le fuseau de l'application (APP_TIMEZONE).
 */

const TACHES = [
  // § 11 — statuts des échéances (à venir → à payer → en retard) et horizon glissant.
  {
    nom: 'echeances', planification: '15 0 * * *',
    fn: async () => ({
      statuts: await echeances.mettreAJourStatuts(),
      prolongees: await echeances.prolongerHorizons(),
      charges: await charges.mettreAJourStatutsCharges(),
    }),
  },
  // § 14 / § 54.2 — relances J-3, J0, J+3, J+7, J+15 (le matin, pas la nuit).
  { nom: 'relances', planification: '0 9 * * *', fn: () => relances.envoyerRelances() },
  // § 12 — demandes de paiement abandonnées.
  { nom: 'expiration_paiements', planification: '*/10 * * * *', fn: () => paiementsLocataire.expirerDemandes() },
  // § 55.4 — rappels de restitution de caution.
  { nom: 'cautions', planification: '30 8 * * *', fn: () => cautions.alertesRestitution() },
  // § 52.3 — acceptation tacite des états des lieux au terme du délai de réponse.
  { nom: 'etats_des_lieux', planification: '5 * * * *', fn: () => etatsDesLieux.accepterTacitement() },
  // § 31 — abonnements et essais échus → lecture seule.
  { nom: 'abonnements', planification: '0 1 * * *', fn: () => abonnements.expirerAbonnements() },
  // § 13 — PDF de quittance non produit après le paiement (stockage momentanément
  // indisponible) : repris ici, hors de toute transaction de paiement.
  { nom: 'quittances_manquantes', planification: '*/10 * * * *', fn: () => quittances.produireDocumentsManquants() },
  // Données techniques échues.
  { nom: 'nettoyage', planification: '30 3 * * *', fn: () => nettoyer() },
];

function demarrerJobs() {
  return TACHES.map(({ nom, planification, fn }) => cron.schedule(
    planification,
    () => executerJob(nom, fn),
    { timezone: FUSEAU, name: nom, noOverlap: true }
  ));
}

module.exports = { demarrerJobs, TACHES };
