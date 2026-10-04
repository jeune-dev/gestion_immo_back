'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Contexte de la requête (ou du job) en cours, lisible depuis n'importe quel
 * service sans le faire descendre en paramètre.
 *
 * Sans lui, un journal écrit au fond d'un service (« échec d'envoi d'e-mail »,
 * « notification non créée ») ne disait ni QUELLE requête l'avait déclenché,
 * ni pour QUEL utilisateur : impossible de relier la ligne d'erreur à
 * l'appel du mobile qui l'avait provoquée. Le logger lit ce contexte et
 * ajoute `requestId` / `utilisateurId` à chaque ligne (voir logger.js).
 *
 * Vérifié sur Node 24 : le contexte survit au parsing du corps JSON
 * (express.json) et aux `await` du contrôleur.
 */
const stockage = new AsyncLocalStorage();

/** Exécute `fn` dans `contexte` ; tout ce qu'elle déclenche en hérite. */
function executerDansContexte(contexte, fn) {
  return stockage.run(contexte, fn);
}

/** Contexte courant, ou `null` hors requête et hors job. */
function contexteCourant() {
  return stockage.getStore() || null;
}

module.exports = { executerDansContexte, contexteCourant };
