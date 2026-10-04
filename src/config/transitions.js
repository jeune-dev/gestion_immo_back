'use strict';

const { ConflictError } = require('../errors/AppError.js');

/**
 * Tables de transitions des workflows (§ 18, § 23, § 52).
 *
 * Une transition absente de la table est refusée par `verifierTransition` avec
 * un 409 et un code stable : le mobile sait qu'il affichait un état périmé.
 */

const TRAVAUX = Object.freeze({
  signale: ['a_valider', 'valide', 'annule'],
  a_valider: ['valide', 'annule'],
  valide: ['artisan_assigne', 'en_cours', 'annule'],
  artisan_assigne: ['en_cours', 'valide', 'annule'],
  en_cours: ['termine', 'annule'],
  termine: [],
  annule: [],
});

const INCIDENT = Object.freeze({
  signale: ['en_analyse', 'travaux_planifies', 'resolu', 'rejete'],
  en_analyse: ['travaux_planifies', 'resolu', 'rejete'],
  travaux_planifies: ['resolu', 'en_analyse'],
  resolu: [],
  rejete: [],
});

const ETAT_DES_LIEUX = Object.freeze({
  brouillon: ['soumis'],
  soumis: ['accepte', 'conteste'],
  conteste: ['remplace'],
  accepte: ['remplace'],
  remplace: [],
});

/**
 * @param {Record<string, string[]>} table
 * @param {string} de
 * @param {string} vers
 * @param {string} libelle  — ressource, pour le message d'erreur
 */
function verifierTransition(table, de, vers, libelle) {
  if (de === vers) {
    throw new ConflictError(`${libelle} est déjà au statut « ${vers} ».`, 'TRANSITION_INVALIDE');
  }
  const permises = table[de] || [];
  if (!permises.includes(vers)) {
    throw new ConflictError(
      `Transition impossible pour ${libelle} : « ${de} » → « ${vers} ».`,
      'TRANSITION_INVALIDE',
      { statutActuel: de, statutsPossibles: permises }
    );
  }
}

module.exports = { TRAVAUX, INCIDENT, ETAT_DES_LIEUX, verifierTransition };
