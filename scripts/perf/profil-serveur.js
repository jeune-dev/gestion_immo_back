'use strict';

/**
 * Lance src/server.js sous le PROFILEUR CPU de V8 (scripts/perf/charge.js
 * --profil) : au bout de PROFIL_DUREE_S secondes, le profil est écrit dans
 * tmp/perf-serveur.cpuprofile (ouvrable dans Chrome DevTools › Performance)
 * et le résumé des fonctions les plus coûteuses dans tmp/perf-profil.txt.
 *
 * `node --cpu-prof` n'écrit son profil qu'à une sortie normale, impossible à
 * provoquer proprement sous Windows depuis le processus parent : on pilote
 * donc le profileur par le module `inspector`.
 */
const fs = require('fs');
const path = require('path');
const inspector = require('inspector');

const DUREE_S = Number(process.env.PROFIL_DUREE_S || 30);
const sortie = path.resolve(__dirname, '..', '..', 'tmp');

const session = new inspector.Session();
session.connect();
session.post('Profiler.enable', () => session.post('Profiler.start', () => {
  require('../../src/server.js');
  setTimeout(() => session.post('Profiler.stop', (err, { profile }) => {
    fs.writeFileSync(path.join(sortie, 'perf-serveur.cpuprofile'), JSON.stringify(profile));
    // Temps PROPRE par fonction (échantillons), regroupé par fichier.
    const parId = new Map(profile.nodes.map((n) => [n.id, n]));
    const propre = new Map();
    const parFichier = new Map();
    const pas = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
    for (const id of profile.samples) {
      const { callFrame: f } = parId.get(id);
      const fichier = (f.url || '(natif)').replace(/^.*node_modules[\\/]/, 'node_modules/').replace(/^file:\/\/\/.*?back[\\/]/, '');
      const paquet = fichier.startsWith('node_modules/') ? fichier.split('/').slice(0, 2).join('/') : fichier.split(/[\\/]/).slice(0, 3).join('/');
      const cle = `${f.functionName || '(anonyme)'}  ${fichier}:${f.lineNumber + 1}`;
      propre.set(cle, (propre.get(cle) || 0) + pas);
      parFichier.set(paquet, (parFichier.get(paquet) || 0) + pas);
    }
    const total = profile.samples.length * pas;
    const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, ms]) => `${(ms / total * 100).toFixed(1).padStart(5)} %  ${k}`);
    fs.writeFileSync(path.join(sortie, 'perf-profil.txt'), [
      `Profil CPU du serveur — ${DUREE_S} s`, '', 'Par module :', ...top(parFichier, 25),
      '', 'Par fonction (temps propre) :', ...top(propre, 40),
    ].join('\n'));
    process.exit(0);
  }), DUREE_S * 1000).unref();
}));
