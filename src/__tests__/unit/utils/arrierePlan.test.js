'use strict';

const arrierePlan = require('../../../utils/arrierePlan.js');

/**
 * Tâches d'arrière-plan : le travail qui continue après la réponse HTTP doit
 * rester attendable — à l'arrêt du processus comme avant une mesure globale
 * dans les tests.
 */
describe('Tâches d’arrière-plan', () => {
  afterEach(async () => { await arrierePlan.attendre(); });

  test('attendre() rend la main quand toutes les tâches sont finies', async () => {
    const fini = [];
    arrierePlan.lancer(new Promise((r) => setTimeout(r, 10)).then(() => fini.push('a')));
    arrierePlan.lancer(new Promise((r) => setTimeout(r, 25)).then(() => fini.push('b')));
    expect(arrierePlan.enCours.size).toBe(2);
    expect(await arrierePlan.attendre()).toBe(true);
    expect(fini).toEqual(['a', 'b']);
    expect(arrierePlan.enCours.size).toBe(0);
  });

  test('une tâche en échec ne bloque ni ne fait échouer l’attente', async () => {
    arrierePlan.lancer(Promise.reject(new Error('réseau coupé')));
    await expect(arrierePlan.attendre()).resolves.toBe(true);
    expect(arrierePlan.enCours.size).toBe(0);
  });

  test('une tâche qui en lance une autre est attendue aussi', async () => {
    let imbriquee = false;
    arrierePlan.lancer(Promise.resolve().then(() => {
      arrierePlan.lancer(new Promise((r) => setTimeout(r, 10)).then(() => { imbriquee = true; }));
    }));
    await arrierePlan.attendre();
    expect(imbriquee).toBe(true);
  });

  test('sans tâche en cours, attendre() ne coûte rien', async () => {
    expect(arrierePlan.enCours.size).toBe(0);
    await expect(arrierePlan.attendre()).resolves.toBe(true);
  });

  test('une tâche bloquée ne fige pas l’attente : elle rend la main au délai', async () => {
    let debloquer;
    arrierePlan.lancer(new Promise((r) => { debloquer = r; }));
    const depart = Date.now();
    expect(await arrierePlan.attendre({ delaiMs: 50 })).toBe(false);
    expect(Date.now() - depart).toBeLessThan(2000);
    debloquer();
  });
});
