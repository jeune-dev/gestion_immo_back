'use strict';

const crypto = require('crypto');
const {
  api, nouveauProprietaire, creerImmeuble, expirerAbonnement, fermer, sequelize,
} = require('../../../setup/helpers.js');
const droits = require('../../../../modules/abonnement/service/droits.service.js');

/**
 * Audit #24 (FAIBLE) — § 31 : abonnement échu ou suspendu = espace en LECTURE
 * SEULE. Les rapports (fonctionnalité du plan) répondaient 402 en lecture
 * parce que `exigerFonctionnalite` exigeait aussi l'abonnement ACTIF. En
 * lecture, seule l'inclusion de la fonctionnalité dans le plan compte ; toute
 * écriture reste refusée (402).
 */

const RAPPORTS = ['financier', 'immobilier', 'travaux', 'locataires', 'rentabilite'];
const PERIODE = { du: '2026-09-01', au: '2026-09-30' };

describe('Rapports et abonnement échu (§ 31 lecture seule)', () => {
  afterAll(fermer);

  test('période échue (statut encore « essai ») : GET de chaque rapport → 200 ; écritures → 402', async () => {
    const p = await nouveauProprietaire();
    const immeuble = await creerImmeuble(p);
    await expirerAbonnement(p.ownerId);

    for (const type of RAPPORTS) {
      const res = await api().get(`/api/v1/rapports/${type}`).query(PERIODE).set(p.h);
      expect([type, res.status]).toEqual([type, 200]);
    }
    const csv = await api().get('/api/v1/rapports/financier').query({ ...PERIODE, format: 'csv' }).set(p.h);
    expect(csv.status).toBe(200);

    const ecriture = await api().post('/api/v1/depenses').set(p.h).send({ amount: 1000, method: 'especes', spent_on: '2026-09-02', building_id: immeuble.id, category_id: crypto.randomUUID() });
    expect(ecriture.status).toBe(402);
    expect(ecriture.body.error.code).toBe('ABONNEMENT_REQUIS');
    expect((await api().post('/api/v1/caisse/autres-revenus').set(p.h).send({ amount: 1, method: 'especes', occurred_on: '2026-09-02', label: 'Test' })).status).toBe(402);
  });

  test('abonnement passé « expire » par le job : la lecture des rapports reste permise (plan du dernier abonnement)', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE subscriptions SET status = 'expire', current_period_start = '2019-12-01', current_period_end = '2020-01-01' WHERE owner_id = :o", { replacements: { o: p.ownerId } });
    await droits.invalider(p.ownerId);
    const res = await api().get('/api/v1/rapports/financier').query(PERIODE).set(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data.rapport.periode).toMatchObject(PERIODE);
    expect((await api().post('/api/v1/artisans').set(p.h).send({ name: 'Ousmane', trade: 'plombier' })).status).toBe(402);
  });

  test('abonnement suspendu par l’administrateur : lecture 200, écriture 402', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE subscriptions SET status = 'suspendu', suspended_reason = 'Impayé' WHERE owner_id = :o", { replacements: { o: p.ownerId } });
    await droits.invalider(p.ownerId);
    expect((await api().get('/api/v1/rapports/rentabilite').query(PERIODE).set(p.h)).status).toBe(200);
    expect((await api().post('/api/v1/incidents').set(p.h).send({})).status).toBe(402);
  });

  test('fonctionnalité ABSENTE du plan : 403 FONCTIONNALITE_NON_INCLUSE, que l’abonnement soit actif ou échu', async () => {
    const p = await nouveauProprietaire();
    const [[plan]] = await sequelize.query(`
      INSERT INTO subscription_plans (code, name, price, features, status, sort_order)
      VALUES (:code, 'Sans rapports', 1000, ARRAY['messagerie']::text[], 'actif', 99) RETURNING id`,
    { replacements: { code: `SANSRAP${crypto.randomBytes(3).toString('hex')}` } });
    await sequelize.query('UPDATE subscriptions SET plan_id = :plan WHERE owner_id = :o', { replacements: { plan: plan.id, o: p.ownerId } });
    await droits.invalider(p.ownerId);

    const actif = await api().get('/api/v1/rapports/financier').query(PERIODE).set(p.h);
    expect(actif.status).toBe(403);
    expect(actif.body.error.code).toBe('FONCTIONNALITE_NON_INCLUSE');

    await expirerAbonnement(p.ownerId);
    const echu = await api().get('/api/v1/rapports/financier').query(PERIODE).set(p.h);
    expect(echu.status).toBe(403);
    expect(echu.body.error.code).toBe('FONCTIONNALITE_NON_INCLUSE');
  });

  test('abonnement actif : rapports accessibles (aucune régression)', async () => {
    const p = await nouveauProprietaire();
    expect((await api().get('/api/v1/rapports/travaux').query(PERIODE).set(p.h)).status).toBe(200);
  });
});
