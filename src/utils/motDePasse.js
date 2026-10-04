'use strict';

/**
 * Hachage des mots de passe — bcrypt NATIF, hors de la boucle d'événements.
 *
 * CORRECTIF (audit performance) : tout le projet hachait avec `bcryptjs`,
 * implémentation en JavaScript pur. Chaque `compare` à 12 tours occupe le
 * thread principal par tranches d'environ 100 ms : pendant une connexion, le
 * process ne répond à PERSONNE d'autre. Mesuré sur le poste de dév (i5-8265U,
 * Node 24, 12 tours) :
 *
 *   connexions simultanées   bcryptjs                  bcrypt natif
 *   1                        boucle bloquée 101 ms     15 ms
 *   10                       p99 1 011 ms, 2,1 /s      p99 44 ms, 8,2 /s
 *   50                       p99 5 113 ms, 2,0 /s      p99 47 ms, 9,7 /s
 *
 * Autrement dit, 50 connexions simultanées gelaient pendant plus de cinq
 * secondes toutes les autres requêtes du worker (listes, synchronisation,
 * téléchargements). Le module natif calcule dans le pool de threads libuv :
 * la boucle reste disponible et le débit est multiplié par ~4,8.
 *
 * Les empreintes sont les MÊMES (`$2b$`, vérifiées dans les deux sens) :
 * aucune migration des mots de passe existants.
 *
 * Repli sur `bcryptjs` si le binaire natif ne se charge pas (plateforme sans
 * binaire précompilé) : l'application reste fonctionnelle, plus lente, et le
 * dit au démarrage.
 */

let impl;
let implementation;
try {
  impl = require('bcrypt');
  implementation = 'natif';
} catch (err) {
  impl = require('bcryptjs');
  implementation = 'js';
  require('./logger.js').warn(
    `[motDePasse] bcrypt natif indisponible (${err.message}) — repli sur bcryptjs : `
    + 'chaque connexion bloquera la boucle d’événements.'
  );
}

module.exports = {
  /** @param {string} motDePasse  @param {number} tours  @returns {Promise<string>} */
  hash: (motDePasse, tours) => impl.hash(motDePasse, tours),
  /** @param {string} motDePasse  @param {string} empreinte  @returns {Promise<boolean>} */
  compare: (motDePasse, empreinte) => impl.compare(motDePasse, empreinte),
  /** 'natif' ou 'js' — exposé pour la supervision et les tests. */
  implementation,
};
