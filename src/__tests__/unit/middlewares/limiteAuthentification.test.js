'use strict';

const express = require('express');
const request = require('supertest');
const rateLimit = require('express-rate-limit');
const { authRateLimitConfig, formaterDelai } = require('../../../config/security.js');

/**
 * Limiteur des tentatives d'authentification par IP. Au Sénégal, des
 * centaines d'abonnés mobiles partagent la même IP publique (NAT opérateur) :
 * seules les tentatives ÉCHOUÉES doivent compter, sinon quelques connexions
 * normales bloquaient tout le monde « 15 minutes ».
 * Instance dédiée (max = 2) montée sur une application minimale.
 */

function application() {
  const app = express();
  app.use(express.json());
  app.post('/connexion', rateLimit({ ...authRateLimitConfig, max: 2 }), (req, res) => res.status(req.body.statut || (req.body.ok ? 200 : 401)).json({}));
  return app;
}

describe('Limiteur des tentatives d’authentification', () => {
  test('les connexions réussies ne consomment pas le quota de l’IP', async () => {
    const app = application();
    for (let i = 0; i < 10; i += 1) expect((await request(app).post('/connexion').send({ ok: true })).status).toBe(200);
    expect((await request(app).post('/connexion').send({ ok: false })).status).toBe(401);
  });

  test('compte déjà bloqué (429 COMPTE_BLOQUE) : ne consomme pas le quota de l’IP', async () => {
    const app = application();
    for (let i = 0; i < 10; i += 1) expect((await request(app).post('/connexion').send({ statut: 429 })).status).toBe(429);
    expect((await request(app).post('/connexion').send({ ok: false })).status).toBe(401);
  });

  test('au-delà du quota d’échecs : 429 avec le délai réel et Retry-After', async () => {
    const app = application();
    await request(app).post('/connexion').send({ ok: false });
    await request(app).post('/connexion').send({ ok: false });
    const res = await request(app).post('/connexion').send({ ok: true });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TROP_DE_REQUETES');
    expect(res.body.message).toBe('Trop de tentatives incorrectes depuis ce réseau. Réessayez dans 15 minutes.');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('formaterDelai', () => {
  test.each([
    [0, '1 minute'],
    [30_000, '1 minute'],
    [60_000, '1 minute'],
    [61_000, '2 minutes'],
    [14 * 60_000 + 1, '15 minutes'],
  ])('%i ms → %s', (ms, texte) => expect(formaterDelai(ms)).toBe(texte));
});
