'use strict';

/**
 * Couverture des ROUTES : chaque route Express réellement appelée par un test
 * est enregistrée (méthode + motif complet, ex. `GET /api/v1/baux/:id`), puis
 * `scripts/couverture-routes.js` la compare à la liste réelle des routes de
 * l'application. On obtient ainsi la liste EXACTE des API testées et non
 * testées, au lieu d'une estimation.
 *
 * Exécuté après l'installation du framework (setupFilesAfterEnv).
 */
const fs = require('fs');
const path = require('path');
const { Route } = require('router');

const impacts = new Set();
if (!Route.prototype.__impactsInstalles) {
  const dispatchOrigine = Route.prototype.dispatch;
  Route.prototype.dispatch = function dispatch(req, res, done) {
    impacts.add(`${req.method} ${req.baseUrl}${this.path}`);
    return dispatchOrigine.call(this, req, res, done);
  };
  Route.prototype.__impactsInstalles = true;
}

afterAll(() => {
  if (!impacts.size) return;
  const dossier = path.resolve(__dirname, '..', '..', '..', 'tmp', 'route-hits');
  fs.mkdirSync(dossier, { recursive: true });
  const fichier = path.join(dossier, `${process.env.JEST_WORKER_ID || 0}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(fichier, JSON.stringify([...impacts]));
});
