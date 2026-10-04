'use strict';

const os = require('os');
const logger = require('../utils/logger.js');
const metrics = require('../utils/metrics.js');

/**
 * Alertes d'exploitation (constat M9 de l'audit : aucun incident n'était
 * signalé à personne — un disjoncteur ouvert, une tâche nocturne en échec ou
 * une rafale d'erreurs serveur passaient inaperçus).
 *
 * Canaux (au moins un est OBLIGATOIRE en production, config/security.js) :
 *   - ALERT_WEBHOOK_URL : POST JSON { text, … } — accepté tel quel par Slack,
 *     Mattermost, Discord (champ `content` ajouté), Microsoft Teams (webhook
 *     « workflows ») ou tout collecteur maison ;
 *   - ALERT_EMAIL : une ou plusieurs adresses (séparées par des virgules),
 *     via le service e-mail de l'application.
 *
 * Anti-répétition : une alerte d'un TYPE donné part au plus une fois par
 * ALERTE_ANTI_REPETITION_MIN minutes (15 par défaut) et par processus ; les
 * occurrences suivantes sont comptées (métriques) et journalisées.
 * Ne lève JAMAIS d'exception : une alerte qui échoue ne doit pas aggraver
 * l'incident qu'elle signale.
 */

const TYPES = Object.freeze({
  PROCESSUS_ARRETE: 'processus_arrete',
  DEPENDANCE_INDISPONIBLE: 'dependance_indisponible',
  TACHE_EN_ECHEC: 'tache_en_echec',
  ERREURS_SERVEUR: 'erreurs_serveur',
  REJEU_SESSION: 'rejeu_session',
  ABUS_LIMITES: 'abus_limites',
  VERROUILLAGE_SUPER_ADMIN: 'verrouillage_super_admin',
});

const derniersEnvois = new Map();
const delaiMs = () => Math.max(0, Number(process.env.ALERTE_ANTI_REPETITION_MIN ?? 15)) * 60 * 1000;
const DELAI_RESEAU_MS = 5000;

async function envoyerWebhook(url, charge) {
  const controleur = new AbortController();
  const minuterie = setTimeout(() => controleur.abort(), DELAI_RESEAU_MS);
  try {
    const reponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(charge),
      signal: controleur.signal,
    });
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
  } finally {
    clearTimeout(minuterie);
  }
}

/**
 * @param {string} type     un des TYPES
 * @param {string} message  phrase lisible, SANS donnée personnelle ni secret
 * @param {object} [details] contexte technique court (identifiants, compteurs)
 * @returns {Promise<{ envoye: boolean, motif?: string, canaux?: string[] }>}
 */
async function alerter(type, message, details = {}) {
  try {
    metrics.incrementer(`alerte.${type}`);
    logger.error(`[ALERTE] ${type} : ${message}`, { alerte: type, ...details });

    const maintenant = Date.now();
    const precedent = derniersEnvois.get(type);
    if (precedent !== undefined && maintenant - precedent < delaiMs()) return { envoye: false, motif: 'anti_repetition' };
    derniersEnvois.set(type, maintenant);

    const environnement = process.env.NODE_ENV || 'development';
    const texte = `[${environnement}] ${type} — ${message}`;
    const envois = [];
    const canaux = [];
    if (process.env.ALERT_WEBHOOK_URL) {
      canaux.push('webhook');
      envois.push(envoyerWebhook(process.env.ALERT_WEBHOOK_URL, {
        text: texte, content: texte, type, message, environnement, hote: os.hostname(), date: new Date(maintenant).toISOString(), details,
      }));
    }
    const destinataires = String(process.env.ALERT_EMAIL || '').split(',').map((a) => a.trim()).filter(Boolean);
    if (destinataires.length) {
      canaux.push('email');
      // Chargé à l'appel : le service e-mail utilise lui-même le disjoncteur,
      // qui peut déclencher une alerte (pas de dépendance circulaire au chargement).
      const email = require('./email.service.js');
      for (const a of destinataires) {
        envois.push(email.envoyer({
          a,
          sujet: `[ALERTE ${environnement}] ${type}`,
          texte: `${message}\n\nHôte : ${os.hostname()}\nDate : ${new Date(maintenant).toISOString()}\nDétails : ${JSON.stringify(details)}`,
          html: `<p><strong>${type}</strong></p><p>${String(message).replace(/[<>&]/g, '')}</p>`,
        }));
      }
    }
    if (!envois.length) return { envoye: false, motif: 'aucun_canal' };
    const resultats = await Promise.allSettled(envois);
    const echecs = resultats.filter((r) => r.status === 'rejected');
    if (echecs.length) logger.warn('[alerte] Envoi impossible sur un canal', { alerte: type, erreur: echecs[0].reason?.message });
    return { envoye: echecs.length < envois.length, canaux };
  } catch (err) {
    logger.warn('[alerte] Échec interne du service d’alertes', { erreur: err.message });
    return { envoye: false, motif: 'erreur' };
  }
}

// ── Rafales (erreurs serveur, dépassements de limites) ─────────────────────

/** Compteur à fenêtre glissante d'une minute : alerte au franchissement du seuil. */
function compteurRafale(type, seuilVariable, seuilDefaut, message) {
  const horodatages = [];
  return (details = {}) => {
    const maintenant = Date.now();
    horodatages.push(maintenant);
    while (horodatages.length && maintenant - horodatages[0] > 60_000) horodatages.shift();
    const seuil = Number(process.env[seuilVariable] || seuilDefaut);
    if (horodatages.length >= seuil) {
      alerter(type, `${horodatages.length} ${message} en une minute (seuil ${seuil})`, details);
      horodatages.length = 0;
    }
  };
}

const signalerErreurServeur = compteurRafale(TYPES.ERREURS_SERVEUR, 'ALERTE_SEUIL_5XX_MINUTE', 20, 'erreurs serveur (5xx)');
const signalerDepassementLimite = compteurRafale(TYPES.ABUS_LIMITES, 'ALERTE_SEUIL_LIMITES_MINUTE', 200, 'requêtes refusées par les limites de débit');

/** Pour les tests : oublie l'anti-répétition. */
const reinitialiser = () => derniersEnvois.clear();

module.exports = { alerter, TYPES, signalerErreurServeur, signalerDepassementLimite, reinitialiser };
