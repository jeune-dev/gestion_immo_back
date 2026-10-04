'use strict';

const express = require('express');
const request = require('supertest');
const { creerLimiteActivation } = require('../../../modules/auth/route/limiteActivation.js');

/**
 * Limiteur d'activation locataire PAR TÉLÉPHONE ciblé (§ 32) : un attaquant
 * qui change d'IP ne multiplie pas ses essais contre le même locataire.
 * Instance dédiée (max = 2) montée sur une application minimale.
 */

function application() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.post('/activation', creerLimiteActivation({ windowMs: 60_000, max: 2, standardHeaders: true, legacyHeaders: false }), (req, res) => res.json({ ok: true }));
  return app;
}

describe('Limiteur d’activation par téléphone', () => {
  test('3e essai sur le même téléphone refusé (429), quels que soient le format et l’IP', async () => {
    const app = application();
    const r1 = await request(app).post('/activation').set('X-Forwarded-For', '10.0.0.1').send({ phone: '+221771112233', code: '00000000' });
    const r2 = await request(app).post('/activation').set('X-Forwarded-For', '10.0.0.2').send({ phone: '77 111 22 33', code: '00000001' });
    const r3 = await request(app).post('/activation').set('X-Forwarded-For', '10.0.0.3').send({ phone: '00221771112233', code: '00000002' });
    expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 429]);
  });

  test('un autre téléphone garde son propre compteur', async () => {
    const app = application();
    for (let i = 0; i < 3; i += 1) await request(app).post('/activation').send({ phone: '+221771112244' });
    expect((await request(app).post('/activation').send({ phone: '+221771112255' })).status).toBe(200);
  });

  test('activation par lien (sans téléphone) : non concernée', async () => {
    const app = application();
    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).post('/activation').send({ token: `jeton-${i}` })).status).toBe(200);
    }
  });
});

describe('CORRECTIF E2 — clé du limiteur « mot de passe oublié » par compte visé', () => {
  const { cleCibleOtp } = require('../../../middlewares/rateLimit.middleware.js');
  const cle = (identifiant) => cleCibleOtp({ body: { identifiant } });

  test('toutes les écritures d’un même numéro donnent la MÊME clé', () => {
    const variantes = ['771234567', '+221771234567', '00221771234567', '77 123 45 67', '77-123-45-67', ' +221 77.123.45.67 '];
    expect(new Set(variantes.map(cle)).size).toBe(1);
    expect(cle('771234567')).toBe('tel:+221771234567');
  });

  test('e-mail insensible à la casse et aux espaces ; numéros différents → clés différentes', () => {
    expect(cle(' Awa@Exemple.SN ')).toBe(cle('awa@exemple.sn'));
    expect(cle('771234567')).not.toBe(cle('771234568'));
    expect(cleCibleOtp({ body: {} })).toBeNull();
  });
});
