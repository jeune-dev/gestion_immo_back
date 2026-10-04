'use strict';

const crypto = require('crypto');
const { api, compter, fermer } = require('../../../setup/helpers.js');
const {
  PAYDUNYA, WAVE, FACTURES, simulerFournisseurs, preparerPaydunya, initier, ipn, corpsIpn, enFormulaire, factureDe, ligne,
} = require('./outils.paiements.js');

/**
 * CORRECTIFS M11 de l'audit de sécurité — paiements PayDunya.
 *
 *  1. En PRODUCTION, aucun paiement de TEST (bac à sable) ne confirme un loyer :
 *     configuration, initiation et notification refusent le mode « test »
 *     (dérogation de préproduction : PAIEMENT_MODE_TEST_AUTORISE=1).
 *  2. Une confirmation n'est imputée que si elle correspond à LA transaction
 *     visée (même fournisseur, même jeton de facture) ; sinon « À rapprocher ».
 */

const LIVE = { ...PAYDUNYA, private_key: 'live_private_rMIdJM3PLLhLjyArx9tF3VURAF5', mode: 'live' };
const notifier = (moyenId, corps) => api().post(`/api/v1/webhooks/paydunya/${moyenId}`).type('form').send(enFormulaire(corps));

/** Exécute `fn` comme sur la plateforme de production (lu à chaque appel par le code). */
async function enProduction(fn, { derogation = false } = {}) {
  const avant = { NODE_ENV: process.env.NODE_ENV, PAIEMENT_MODE_TEST_AUTORISE: process.env.PAIEMENT_MODE_TEST_AUTORISE };
  process.env.NODE_ENV = 'production';
  process.env.PAIEMENT_MODE_TEST_AUTORISE = derogation ? '1' : '';
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = avant.NODE_ENV;
    process.env.PAIEMENT_MODE_TEST_AUTORISE = avant.PAIEMENT_MODE_TEST_AUTORISE ?? '';
  }
}

let fournisseurs;
beforeAll(() => { fournisseurs = simulerFournisseurs(); });
afterEach(() => fournisseurs.mode('ok'));
afterAll(async () => {
  fournisseurs.restaurer();
  await fermer();
});

describe('Production : jamais de paiement de test', () => {
  test('configuration : clés PayDunya de test refusées (422 MODE_TEST_INTERDIT), clés live acceptées', async () => {
    const { p } = await preparerPaydunya();
    await enProduction(async () => {
      const test = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: PAYDUNYA });
      expect(test.status).toBe(422);
      expect(test.body.error.code).toBe('MODE_TEST_INTERDIT');
      // Réactiver le moyen existant (resté en mode test) est tout aussi refusé.
      expect((await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', is_active: true })).status).toBe(422);
      const live = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: LIVE });
      expect(live.status).toBe(200);
    });
  });

  test('initiation avec un moyen resté en mode test : refusée, aucune facture créée chez PayDunya', async () => {
    const { loc, echeances } = await preparerPaydunya();
    const appelsAvant = fournisseurs.appels.length;
    const res = await enProduction(() => initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAIEMENT_INTEGRE_INDISPONIBLE');
    expect(fournisseurs.appels.slice(appelsAvant).some((a) => a.url.includes('checkout-invoice/create'))).toBe(false);
  });

  test('notification d’une facture de TEST sur la plateforme de production : refusée, rien n’est payé', async () => {
    const { loc, echeances, providerId } = await preparerPaydunya();
    const reference = (await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' })).body.data.transaction.reference;
    const res = await enProduction(() => notifier(providerId, ipn(reference, echeances[0].amount_due)));
    expect(res.status).toBe(401);
    expect((await ligne('SELECT amount_paid FROM rent_schedules WHERE id = :e', { e: echeances[0].id })).amount_paid).toBe(0);
  });

  test('dérogation de préproduction (PAIEMENT_MODE_TEST_AUTORISE=1) : le mode test fonctionne', async () => {
    const { loc, echeances, providerId } = await preparerPaydunya();
    await enProduction(async () => {
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      expect(init.status).toBe(201);
      expect((await notifier(providerId, ipn(init.body.data.transaction.reference, echeances[0].amount_due))).status).toBe(200);
    }, { derogation: true });
    expect((await ligne('SELECT status FROM rent_schedules WHERE id = :e', { e: echeances[0].id })).status).toBe('paye');
  });
});

describe('Confirmation rattachée à LA transaction visée', () => {
  test('facture étrangère portant la référence d’une transaction : « À rapprocher » (facture_incoherente), rien imputé, une seule entrée', async () => {
    const { loc, echeances, providerId, p } = await preparerPaydunya();
    const reference = (await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' })).body.data.transaction.reference;
    const vraie = factureDe(reference);
    // Facture créée HORS de l'application sur le même compte, avec la même référence.
    const etrangere = {
      token: `test_${crypto.randomBytes(5).toString('hex')}`, total_amount: echeances[0].amount_due, status: 'completed',
      custom_data: { reference }, master_key: PAYDUNYA.master_key, mode: 'test', customer: { phone: '221770000001' }, actions: {},
    };
    FACTURES.set(etrangere.token, etrangere);
    const res = await notifier(providerId, corpsIpn(etrangere));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ a_rapprocher: true });
    expect((await ligne('SELECT amount_paid FROM rent_schedules WHERE id = :e', { e: echeances[0].id })).amount_paid).toBe(0);
    expect(await compter('reconciliation_entries', "owner_id = :o AND details->>'motif' = 'facture_incoherente'", { o: p.ownerId })).toBe(1);
    // Même notification rejouée : aucune entrée de plus.
    expect((await notifier(providerId, corpsIpn(etrangere))).status).toBe(200);
    expect(await compter('reconciliation_entries', "owner_id = :o AND details->>'motif' = 'facture_incoherente'", { o: p.ownerId })).toBe(1);
    // La vraie facture, elle, est imputée normalement.
    Object.assign(vraie, { status: 'completed', total_amount: echeances[0].amount_due });
    expect((await notifier(providerId, corpsIpn(vraie))).status).toBe(200);
    expect((await ligne('SELECT status FROM rent_schedules WHERE id = :e', { e: echeances[0].id })).status).toBe('paye');
  });

  test('notification PayDunya pour une transaction initiée via WAVE : « À rapprocher », rien imputé', async () => {
    const { loc, echeances, providerId, p } = await preparerPaydunya();
    expect((await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'integre', credentials: WAVE })).status).toBe(200);
    const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
    expect(init.status).toBe(201);
    const { reference } = init.body.data.transaction;
    expect((await ligne('SELECT provider FROM payment_transactions WHERE reference = :r', { r: reference })).provider).toBe('wave');
    const res = await notifier(providerId, ipn(reference, echeances[0].amount_due));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ a_rapprocher: true });
    expect((await ligne('SELECT amount_paid FROM rent_schedules WHERE id = :e', { e: echeances[0].id })).amount_paid).toBe(0);
  });
});
