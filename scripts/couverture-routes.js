'use strict';

/**
 * Couverture des ROUTES par les tests : compare les routes réellement appelées
 * pendant la dernière exécution de Jest (tmp/route-hits, écrit par
 * src/__tests__/setup/routeHits.js) à la liste réelle des routes de l'API.
 *
 * Usage : npm run test:routes   (après npm test)
 * Code de sortie 1 si des routes ne sont jamais appelées (CI).
 */
const fs = require('fs');
const path = require('path');

process.env.JOBS_ENABLED = 'false';
const { listerRoutes } = require('./lister-routes.js');

const dossier = path.resolve(__dirname, '..', 'tmp', 'route-hits');
if (!fs.existsSync(dossier)) {
  process.stderr.write('Aucun impact enregistré : lancez d’abord les tests d’intégration / e2e.\n');
  process.exit(2);
}
const impacts = new Set();
for (const f of fs.readdirSync(dossier)) for (const i of JSON.parse(fs.readFileSync(path.join(dossier, f), 'utf8'))) impacts.add(i);

const routes = listerRoutes().map((r) => `${r.methode} ${r.chemin}`);
const testees = routes.filter((r) => impacts.has(r));
const nonTestees = routes.filter((r) => !impacts.has(r));

const rapport = [
  `Routes de l'API : ${routes.length}`,
  `Routes appelées par les tests : ${testees.length} (${((testees.length / routes.length) * 100).toFixed(1)} %)`,
  '',
  '## Routes testées',
  ...testees.map((r) => `- ${r}`),
  '',
  '## Routes NON testées',
  ...(nonTestees.length ? nonTestees.map((r) => `- ${r}`) : ['(aucune)']),
];
fs.mkdirSync(path.resolve(__dirname, '..', 'coverage'), { recursive: true });
fs.writeFileSync(path.resolve(__dirname, '..', 'coverage', 'routes.md'), `${rapport.join('\n')}\n`);
process.stdout.write(`${rapport.slice(0, 2).join('\n')}\nNon testées : ${nonTestees.length}\n${nonTestees.map((r) => `  ${r}`).join('\n')}\n`);
require('../src/config/db.js').close();
process.exitCode = nonTestees.length ? 1 : 0;
