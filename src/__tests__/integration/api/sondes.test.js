'use strict';

const { api, fermer } = require('../../setup/helpers.js');

/**
 * Sondes de supervision et métriques (hors /api/v1) : vivacité, disponibilité
 * (base joignable), métriques protégées par jeton (404 si non configuré,
 * 401 avec un mauvais jeton, JSON ou format Prometheus avec le bon).
 */

afterAll(fermer);

describe('Sondes et métriques', () => {
  test('vivacité : 200 sans dépendance', async () => {
    const res = await api().get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', uptime: expect.any(Number) });
  });

  test.each(['/health', '/health/ready'])('disponibilité %s : 200 base joignable, jamais mis en cache', async (url) => {
    const res = await api().get(url);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('métriques : 404 sans jeton configuré, 401 mauvais jeton, 200 JSON et Prometheus avec le bon', async () => {
    const avant = process.env.METRICS_TOKEN;
    try {
      delete process.env.METRICS_TOKEN;
      expect((await api().get('/metrics')).status).toBe(404);
      process.env.METRICS_TOKEN = 'jeton-metriques-de-test-0123456789';
      expect((await api().get('/metrics').set('Authorization', 'Bearer faux')).status).toBe(401);
      expect((await api().get('/metrics').set('Authorization', 'Bearer jeton-metriques-de-test-012345678X')).status).toBe(401);
      const json = await api().get('/metrics').set('Authorization', 'Bearer jeton-metriques-de-test-0123456789');
      expect(json.status).toBe(200);
      expect(json.headers['cache-control']).toBe('no-store');
      const prom = await api().get('/metrics?format=prometheus').set('Authorization', 'Bearer jeton-metriques-de-test-0123456789');
      expect(prom.status).toBe(200);
      expect(prom.headers['content-type']).toMatch(/text\/plain/);
    } finally {
      if (avant === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = avant;
    }
  });
});
