'use strict';

/**
 * Tâches d'arrière-plan : le travail qui continue APRÈS la réponse HTTP.
 *
 * Diffusion des notifications (push, WhatsApp), libération des clés
 * d'idempotence : le client n'a pas à les attendre, c'est voulu. Mais une
 * tâche lancée et oubliée n'est observable par personne — ni à l'arrêt du
 * processus, où elle est perdue en silence, ni dans les tests, où une
 * écriture en retard se fait compter dans la mesure du test suivant (une
 * insertion `message_deliveries` au milieu d'un relevé de requêtes SQL).
 *
 * `lancer` les enregistre, `attendre` les laisse finir.
 */

const enCours = new Set();

/**
 * Enregistre une tâche d'arrière-plan jusqu'à son terme.
 * @template T
 * @param {Promise<T>} promesse déjà lancée, et déjà munie de son `catch`
 * @returns {Promise<T>} la même tâche, pour pouvoir l'attendre si besoin
 */
function lancer(promesse) {
  const tache = Promise.resolve(promesse).finally(() => enCours.delete(tache));
  enCours.add(tache);
  return tache;
}

/**
 * Attend la fin des tâches en cours, y compris celles qu'elles lancent
 * elles-mêmes. Utilisé à l'arrêt du processus et avant toute mesure globale
 * dans les tests.
 *
 * Borné : une tâche bloquée (appel réseau sans délai d'attente) ne doit jamais
 * retenir un arrêt ni figer une suite de tests.
 * @returns {Promise<boolean>} `true` si tout est terminé, `false` si le délai
 *   a été atteint alors qu'il restait des tâches.
 */
async function attendre({ delaiMs = 5000 } = {}) {
  const echeance = Date.now() + delaiMs;
  // Une tâche peut en lancer une autre : on repasse tant que la file se
  // remplit, avec une borne de tours en plus du délai.
  for (let i = 0; enCours.size > 0 && i < 20 && Date.now() < echeance; i += 1) {
    let minuteur;
    const expiration = new Promise((resoudre) => {
      minuteur = setTimeout(resoudre, Math.max(0, echeance - Date.now()));
      minuteur.unref?.();
    });
    await Promise.race([Promise.allSettled([...enCours]), expiration]);
    clearTimeout(minuteur);
  }
  return enCours.size === 0;
}

module.exports = { lancer, attendre, enCours };
