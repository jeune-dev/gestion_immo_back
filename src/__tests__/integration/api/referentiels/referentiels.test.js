'use strict';

const { api, fermer } = require('../../../setup/helpers.js');
const enums = require('../../../../config/enums.js');

/**
 * Référentiels publics : codes et libellés de `config/enums.js`, sans
 * authentification, sans donnée personnelle, mis en cache HTTP.
 */

afterAll(fermer);

describe('GET /referentiels', () => {
  test('public : 200 sans jeton, cache HTTP d’une heure', async () => {
    const res = await api().get('/api/v1/referentiels');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.body.success).toBe(true);
  });

  test('chaque énumération exposée en tableau ordonné { code, label }, identique à la source', async () => {
    const { enumerations, correspondances } = (await api().get('/api/v1/referentiels')).body.data;
    expect(enumerations.statut_appartement).toEqual([
      { code: 'disponible', label: 'Disponible' }, { code: 'occupe', label: 'Occupé' },
      { code: 'en_travaux', label: 'En travaux' }, { code: 'indisponible', label: 'Indisponible' },
    ]);
    for (const [nom, valeur] of Object.entries(enums)) {
      if (typeof valeur !== 'object' || valeur === null) continue;
      const cle = nom.toLowerCase();
      if (Object.values(valeur).every((v) => typeof v === 'string')) {
        expect(enumerations[cle].map((e) => e.code)).toEqual(Object.keys(valeur));
      } else {
        expect(correspondances[cle]).toEqual({ ...valeur });
      }
    }
  });

  test('jeton invalide ignoré (route publique) ; paramètres inconnus sans effet', async () => {
    const res = await api().get('/api/v1/referentiels').query({ x: "' OR 1=1 --" }).set('Authorization', 'Bearer faux');
    expect(res.status).toBe(200);
  });

  test('méthodes d’écriture : 404', async () => {
    expect((await api().post('/api/v1/referentiels').send({})).status).toBe(404);
    expect((await api().delete('/api/v1/referentiels')).status).toBe(404);
  });
});
