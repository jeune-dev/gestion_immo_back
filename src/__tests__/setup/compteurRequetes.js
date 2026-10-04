'use strict';

/**
 * Compteur de requêtes SQL (détection des N+1).
 *
 * Toutes les requêtes passent par `sequelize.query` (modèles compris) : le
 * hook `afterQuery` voit donc chaque aller-retour vers PostgreSQL, y compris
 * BEGIN / COMMIT. `mesurer(fn)` renvoie le nombre de requêtes émises pendant
 * `fn` et leur forme NORMALISÉE (littéraux remplacés par `?`), ce qui permet
 * de regrouper « la même requête exécutée N fois avec des valeurs
 * différentes » — la signature d'un N+1.
 */
const sequelize = require('../../config/db.js');

let enCours = null;

sequelize.addHook('afterQuery', (options, query) => {
  if (enCours) enCours.push(query?.sql || '');
});

/** Forme d'une requête sans ses valeurs : deux N+1 identiques ont la même forme. */
function normaliser(sql) {
  return String(sql)
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .replace(/\(\s*\?(\s*,\s*\?)*\s*\)/g, '(?…)')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Exécute `fn` et renvoie `{ resultat, total, formes }` (formes : Map forme → occurrences). */
async function mesurer(fn) {
  if (enCours) throw new Error('mesurer() ne peut pas être imbriqué');
  enCours = [];
  let requetes;
  let resultat;
  try {
    resultat = await fn();
  } finally {
    requetes = enCours;
    enCours = null;
  }
  const formes = new Map();
  for (const sql of requetes) {
    const f = normaliser(sql);
    formes.set(f, (formes.get(f) || 0) + 1);
  }
  return { resultat, total: requetes.length, formes };
}

/** Formes dont le nombre d'exécutions augmente entre deux mesures (les coupables d'un N+1). */
function formesEnHausse(avant, apres) {
  const hausse = [];
  for (const [forme, n] of apres.formes) {
    const m = avant.formes.get(forme) || 0;
    if (n > m) hausse.push(`${m} → ${n} × ${forme}`);
  }
  return hausse;
}

module.exports = { mesurer, normaliser, formesEnHausse };
