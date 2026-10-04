'use strict';

/**
 * Liste toutes les routes de l'API à partir du routeur Express réel — source
 * de docs/API.md (`npm run doc:routes`), qui ne peut donc pas diverger du code.
 *
 * Express 5 ne conserve pas le chemin de montage d'un sous-routeur sous forme
 * de chaîne : on l'enregistre au moment du `use`, avant de charger l'app.
 */
require('dotenv').config({ quiet: true });

const express = require('express');

const MONTAGE = Symbol('montage');
function marquer(proto) {
  const useOrigine = proto.use;
  proto.use = function use(chemin, ...reste) {
    const pile = () => (this.stack || this.router?.stack || []);
    const avant = pile().length;
    const resultat = useOrigine.call(this, chemin, ...reste);
    const texte = typeof chemin === 'string' ? chemin : '';
    const apres = pile();
    for (let i = avant; i < apres.length; i += 1) apres[i][MONTAGE] = texte;
    return resultat;
  };
}
// Chaque routeur a son propre objet prototype : on remonte jusqu'à celui qui
// définit réellement `use`, partagé par tous.
let proto = Object.getPrototypeOf(express.Router());
while (proto && !Object.prototype.hasOwnProperty.call(proto, 'use')) proto = Object.getPrototypeOf(proto);
marquer(proto);
marquer(express.application);

const app = require('../src/app.js');

function parcourir(pile, base, routes) {
  for (const couche of pile) {
    if (couche.route) {
      for (const m of Object.keys(couche.route.methods)) {
        if (m !== '_all') routes.push({ methode: m.toUpperCase(), chemin: `${base}${couche.route.path}` });
      }
    } else if (couche.handle?.stack) {
      parcourir(couche.handle.stack, `${base}${couche[MONTAGE] || ''}`, routes);
    }
  }
  return routes;
}

/** Routes de l'application : [{ methode, chemin }]. */
function listerRoutes() {
  return parcourir(app.router.stack, '', []);
}

if (require.main === module) {
  for (const r of listerRoutes()) process.stdout.write(`${r.methode.padEnd(6)} ${r.chemin}\n`);
  require('../src/config/db.js').close();
}

module.exports = { listerRoutes };
