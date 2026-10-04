'use strict';

const express = require('express');
const request = require('supertest');
const rateLimit = require('express-rate-limit');
const alertes = require('../../../infrastructure/alertes.service.js');
const email = require('../../../infrastructure/email.service.js');
const metrics = require('../../../utils/metrics.js');
const logger = require('../../../utils/logger.js');
const { journaliserDepassement } = require('../../../middlewares/rateLimit.middleware.js');
const errorHandler = require('../../../middlewares/errorHandler.middleware.js');
const { Disjoncteur } = require('../../../utils/circuitBreaker.js');

/**
 * CORRECTIF M9 de l'audit de sécurité — alertes d'exploitation et traçage.
 */

const ENV = { ...process.env };
let fetchOrigine;
beforeEach(() => {
  fetchOrigine = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
  alertes.reinitialiser();
  process.env.ALERT_WEBHOOK_URL = 'https://alertes.exemple.sn/hook';
  process.env.ALERT_EMAIL = '';
  process.env.ALERTE_ANTI_REPETITION_MIN = '15';
});
afterEach(() => {
  global.fetch = fetchOrigine;
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

describe('Service d’alertes', () => {
  test('webhook : POST JSON (text + content : Slack, Teams, Discord…), type, message, hôte, date', async () => {
    const r = await alertes.alerter(alertes.TYPES.TACHE_EN_ECHEC, 'Tâche « relances » en échec', { job: 'relances' });
    expect(r).toEqual({ envoye: true, canaux: ['webhook'] });
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://alertes.exemple.sn/hook');
    expect(options.method).toBe('POST');
    const corps = JSON.parse(options.body);
    expect(corps).toMatchObject({ type: 'tache_en_echec', message: 'Tâche « relances » en échec', details: { job: 'relances' } });
    expect(corps.text).toMatch(/tache_en_echec/);
    expect(corps.content).toBe(corps.text);
    expect(corps.hote).toEqual(expect.any(String));
  });

  test('anti-répétition : une alerte d’un même type par période, les autres types passent', async () => {
    await alertes.alerter(alertes.TYPES.ERREURS_SERVEUR, 'a');
    expect(await alertes.alerter(alertes.TYPES.ERREURS_SERVEUR, 'b')).toEqual({ envoye: false, motif: 'anti_repetition' });
    expect((await alertes.alerter(alertes.TYPES.REJEU_SESSION, 'c')).envoye).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('e-mail : une copie par destinataire', async () => {
    process.env.ALERT_WEBHOOK_URL = '';
    process.env.ALERT_EMAIL = 'astreinte@exemple.sn, dsi@exemple.sn';
    const envoi = jest.spyOn(email, 'envoyer').mockResolvedValue({ envoye: true });
    expect(await alertes.alerter(alertes.TYPES.PROCESSUS_ARRETE, 'arrêt')).toEqual({ envoye: true, canaux: ['email'] });
    expect(envoi.mock.calls.map(([e]) => e.a)).toEqual(['astreinte@exemple.sn', 'dsi@exemple.sn']);
    expect(envoi.mock.calls[0][0].sujet).toMatch(/\[ALERTE .*\] processus_arrete/);
  });

  test('jamais d’exception : canal en panne, aucun canal configuré', async () => {
    global.fetch = jest.fn(async () => { throw new Error('réseau coupé'); });
    await expect(alertes.alerter(alertes.TYPES.ABUS_LIMITES, 'x')).resolves.toMatchObject({ envoye: false });
    process.env.ALERT_WEBHOOK_URL = '';
    alertes.reinitialiser();
    await expect(alertes.alerter(alertes.TYPES.ABUS_LIMITES, 'x')).resolves.toEqual({ envoye: false, motif: 'aucun_canal' });
  });

  test('rafale d’erreurs serveur : alerte au franchissement du seuil par minute, pas avant', async () => {
    process.env.ALERTE_SEUIL_5XX_MINUTE = '5';
    for (let i = 0; i < 4; i += 1) alertes.signalerErreurServeur({ code: 'ERREUR_INTERNE' });
    await new Promise((r) => setImmediate(r));
    expect(global.fetch).not.toHaveBeenCalled();
    alertes.signalerErreurServeur({ code: 'ERREUR_INTERNE' });
    await new Promise((r) => setImmediate(r));
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).type).toBe('erreurs_serveur');
  });

  test('disjoncteur : l’ouverture (dépendance en panne) déclenche une alerte', async () => {
    const d = new Disjoncteur('service_test', { seuilEchecs: 2, dureeOuvertureMs: 60_000 });
    for (let i = 0; i < 2; i += 1) await d.executer(async () => { throw new Error('panne'); }).catch(() => {});
    await new Promise((r) => setImmediate(r));
    const corps = global.fetch.mock.calls.map(([, o]) => JSON.parse(o.body));
    expect(corps.some((c) => c.type === 'dependance_indisponible' && c.details.dependance === 'service_test')).toBe(true);
  });
});

describe('Traçage : dépassements de limites et erreurs', () => {
  test('dépassement de limite : journalisé, compté, réponse 429 inchangée', async () => {
    const avertissement = jest.spyOn(logger, 'warn');
    const compteur = jest.spyOn(metrics, 'incrementer');
    const app = express();
    app.use(rateLimit({
      windowMs: 60_000, max: 1, standardHeaders: true, legacyHeaders: false,
      message: () => ({ success: false, error: { code: 'TROP_DE_REQUETES' } }), handler: journaliserDepassement('essai'),
    }));
    app.get('/t', (req, res) => res.json({ ok: true }));
    expect((await request(app).get('/t')).status).toBe(200);
    const refus = await request(app).get('/t');
    expect(refus.status).toBe(429);
    expect(refus.body.error.code).toBe('TROP_DE_REQUETES');
    expect(avertissement.mock.calls.some(([m, c]) => /Limite de débit dépassée/.test(m) && c.limiteur === 'essai')).toBe(true);
    expect(compteur).toHaveBeenCalledWith('rate_limit.depasse.essai');
  });

  test('toute erreur est comptée par code (série api_erreurs_total, jusqu’ici jamais alimentée)', async () => {
    const compte = jest.spyOn(metrics, 'enregistrerErreur');
    const app = express();
    app.get('/t', () => { throw new Error('boum'); });
    app.use(errorHandler);
    expect((await request(app).get('/t')).status).toBe(500);
    expect(compte).toHaveBeenCalledWith('ERREUR_INTERNE');
  });
});

describe('CORRECTIF journaux : aucun fragment du corps de requête sur JSON mal formé', () => {
  test('un mot de passe dans un JSON invalide n’apparaît jamais dans les journaux', async () => {
    const journal = jest.spyOn(logger, 'log');
    const app = express();
    app.use(express.json());
    app.post('/t', (req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    const res = await request(app).post('/t').set('Content-Type', 'application/json').send('{"password":Secret123Tres}');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('JSON_INVALIDE');
    const ecrit = JSON.stringify(journal.mock.calls);
    expect(ecrit).not.toContain('Secret123Tres');
    expect(ecrit).toContain('entity.parse.failed');
  });
});
