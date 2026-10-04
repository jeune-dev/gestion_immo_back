'use strict';

// Filet global par IP abaissé à 3 requêtes pour CE fichier (lu au chargement
// de config/security.js ; chaque fichier de test a son propre registre de modules).
process.env.RATE_LIMIT_GLOBAL_MAX = '3';

const request = require('supertest');
const app = require('../../../../app.js');
const sequelize = require('../../../../config/db.js');

/**
 * PayDunya envoie toutes ses IPN depuis une même adresse : le filet global par
 * IP ne doit jamais bloquer les webhooks (limite dédiée : webhookRateLimit).
 */
describe('Filet global par IP et webhooks', () => {
  afterAll(() => sequelize.close());

  test('au-delà du plafond global, une route ordinaire répond 429 mais les webhooks passent toujours', async () => {
    const statutsReferentiels = [];
    for (let i = 0; i < 5; i += 1) statutsReferentiels.push((await request(app).get('/api/v1/referentiels')).status);
    expect(statutsReferentiels.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statutsReferentiels.slice(3)).toEqual([429, 429]);
    const bloque = await request(app).get('/api/v1/referentiels');
    expect(bloque.body.error.code).toBe('TROP_DE_REQUETES');

    // Même IP, filet global épuisé : les notifications de paiement sont traitées
    // (404 = moyen inconnu, jamais 429).
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app).post('/api/v1/webhooks/paydunya/00000000-0000-4000-8000-000000000000').type('form').send('data%5Bhash%5D=x&data%5Binvoice%5D%5Btoken%5D=X');
      expect(res.status).toBe(404);
    }
    const abonnement = await request(app).post('/api/v1/webhooks/abonnement/paydunya').type('form').send('data%5Bhash%5D=x');
    expect(abonnement.status).not.toBe(429);
  });
});
