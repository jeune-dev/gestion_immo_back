'use strict';

const crypto = require('crypto');
const {
  api, superAdmin, nouveauProprietaire, telephoneUnique, emailUnique, MOT_DE_PASSE, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 30 « Plans tarifaires », § 31 : prix configurables, statut, suppression
 * réservée aux plans jamais souscrits, plan d'essai protégé.
 */

const URL = '/api/v1/admin/plans';
const INCONNU = '00000000-0000-4000-8000-000000000000';
const codePlan = (prefixe = 'T') => `${prefixe}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

let admin;
beforeAll(async () => { admin = await superAdmin(); });
afterAll(fermer);

const creerPlan = async (surcharges = {}) => {
  const res = await api().post(URL).set(admin.h).send({ code: codePlan(), name: 'Formule test', price: 10000, ...surcharges });
  expect(res.status).toBe(201);
  return res.body.data.plan;
};

/** Le plan devient la formule d'essai le temps de `fn` (paramètre plateforme restauré ensuite). */
async function commePlanEssai(code, fn) {
  expect((await api().put('/api/v1/admin/parametres/essai').set(admin.h).send({ plan_code: code, duree_jours: 14 })).status).toBe(200);
  try {
    await fn();
  } finally {
    await api().put('/api/v1/admin/parametres/essai').set(admin.h).send({ plan_code: 'BUSINESS', duree_jours: 14 });
  }
}

describe('Lecture', () => {
  test('liste ordonnée avec nombre d’abonnés ; filtre de statut', async () => {
    const res = await api().get(URL).set(admin.h);
    expect(res.status).toBe(200);
    const business = res.body.data.plans.find((p) => p.code === 'BUSINESS');
    expect(business.subscribers_count).toBe(await compter('subscriptions s JOIN subscription_plans p ON p.id = s.plan_id', "p.code = 'BUSINESS' AND s.status IN ('essai', 'actif', 'suspendu')"));
    const plan = await creerPlan();
    await api().post(`${URL}/${plan.id}/desactiver`).set(admin.h).send({});
    const inactifs = await api().get(URL).query({ status: 'inactif' }).set(admin.h);
    expect(inactifs.body.data.plans.map((p) => p.code)).toContain(plan.code);
    expect(inactifs.body.data.plans.every((p) => p.status === 'inactif')).toBe(true);
    expect((await api().get(URL).query({ status: 'archive' }).set(admin.h)).status).toBe(422);
  });

  test('détail : 200, 404 inconnu, 422 identifiant invalide', async () => {
    const plan = await creerPlan();
    expect((await api().get(`${URL}/${plan.id}`).set(admin.h)).body.data.plan).toMatchObject({ id: plan.id, subscribers_count: 0 });
    expect((await api().get(`${URL}/${INCONNU}`).set(admin.h)).status).toBe(404);
    expect((await api().get(`${URL}/x`).set(admin.h)).status).toBe(422);
  });
});

describe('Création et modification', () => {
  test('création : code mis en majuscules, limites et fonctionnalités, audit', async () => {
    const code = codePlan('min').toLowerCase();
    const res = await api().post(URL).set(admin.h).send({
      code, name: 'Mini', price: 2500, currency: 'xof', billing_period: 'annuel', max_buildings: 1, max_apartments: 3,
      max_whatsapp_per_month: 0, features: ['rapports'], sort_order: 9,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.plan).toMatchObject({ code: code.toUpperCase(), currency: 'XOF', billing_period: 'annuel', max_buildings: 1, features: ['rapports'] });
    expect(await compter('audit_logs', "action = 'plan.creation' AND entity_id = :id", { id: res.body.data.plan.id })).toBe(1);
  });

  test.each([
    ['code manquant', { code: undefined }],
    ['code d’un caractère', { code: 'A' }],
    ['code avec espace', { code: 'MON PLAN' }],
    ['code de 31 caractères', { code: `A${'B'.repeat(30)}` }],
    ['nom manquant', { name: undefined }],
    ['nom de 81 caractères', { name: 'n'.repeat(81) }],
    ['prix manquant', { price: undefined }],
    ['prix négatif', { price: -1 }],
    ['prix décimal', { price: 99.9 }],
    ['devise de 4 lettres', { currency: 'EURO' }],
    ['période inconnue', { billing_period: 'hebdo' }],
    ['limite d’immeubles nulle', { max_buildings: 0 }],
    ['fonctionnalité inconnue', { features: ['teleportation'] }],
    ['fonctionnalité en double', { features: ['rapports', 'rapports'] }],
    ['statut inconnu', { status: 'brouillon' }],
  ])('validation 422 : %s', async (_l, surcharge) => {
    const corps = { code: codePlan(), name: 'X', price: 1000, ...surcharge };
    for (const [cle, valeur] of Object.entries(surcharge)) if (valeur === undefined) delete corps[cle];
    const avant = await compter('subscription_plans');
    expect((await api().post(URL).set(admin.h).send(corps)).status).toBe(422);
    expect(await compter('subscription_plans')).toBe(avant);
  });

  test('code en double : 409 CODE_UTILISE', async () => {
    const plan = await creerPlan();
    const res = await api().post(URL).set(admin.h).send({ code: plan.code.toLowerCase(), name: 'Doublon', price: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CODE_UTILISE');
  });

  test('modification : prix et limites, code et statut non modifiables, audit avec différence', async () => {
    const plan = await creerPlan({ price: 5000 });
    const res = await api().patch(`${URL}/${plan.id}`).set(admin.h).send({ price: 7000, max_apartments: 20, code: 'PIRATE', status: 'inactif' });
    expect(res.status).toBe(200);
    expect(res.body.data.plan).toMatchObject({ code: plan.code, status: 'actif', max_apartments: 20 });
    expect(Number(res.body.data.plan.price)).toBe(7000);
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'plan.modification' AND entity_id = :id", { replacements: { id: plan.id } });
    expect(audit.details).toMatchObject({ code: plan.code, price: { avant: 5000, apres: 7000 } });
    expect((await api().patch(`${URL}/${plan.id}`).set(admin.h).send({})).status).toBe(422);
    expect((await api().patch(`${URL}/${INCONNU}`).set(admin.h).send({ price: 1 })).status).toBe(404);
  });
});

describe('Statut et suppression', () => {
  test('désactivation puis réactivation ; statut inchangé 409', async () => {
    const plan = await creerPlan();
    expect((await api().post(`${URL}/${plan.id}/activer`).set(admin.h).send({})).body.error.code).toBe('STATUT_INCHANGE');
    expect((await api().post(`${URL}/${plan.id}/desactiver`).set(admin.h).send({})).body.data.plan.status).toBe('inactif');
    expect((await api().post(`${URL}/${plan.id}/desactiver`).set(admin.h).send({})).status).toBe(409);
    expect((await api().post(`${URL}/${plan.id}/activer`).set(admin.h).send({})).body.data.plan.status).toBe('actif');
    expect(await compter('audit_logs', "action = 'plan.changement_statut' AND entity_id = :id", { id: plan.id })).toBe(2);
  });

  test('CORRECTIF : le plan d’essai en vigueur ne peut pas être supprimé (409 PLAN_ESSAI), même sans abonné', async () => {
    const plan = await creerPlan();
    await commePlanEssai(plan.code, async () => {
      const res = await api().delete(`${URL}/${plan.id}`).set(admin.h);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PLAN_ESSAI');
      expect(await compter('subscription_plans', 'id = :id', { id: plan.id })).toBe(1);
      // Les inscriptions continuent de recevoir un essai sur ce plan.
      const inscription = await api().post('/api/v1/auth/inscription').send({
        first_name: 'A', last_name: 'B', phone: telephoneUnique(), email: emailUnique(), password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE,
      });
      expect(inscription.status).toBe(201);
      expect(await compter('subscriptions s JOIN owner_members m ON m.owner_id = s.owner_id', 'm.user_id = :u AND s.plan_id = :p', { u: inscription.body.data.user.id, p: plan.id })).toBe(1);
    });
  });

  test('plan d’essai : désactivation refusée elle aussi', async () => {
    const plan = await creerPlan();
    await commePlanEssai(plan.code, async () => {
      expect((await api().post(`${URL}/${plan.id}/desactiver`).set(admin.h).send({})).body.error.code).toBe('PLAN_ESSAI');
    });
  });

  test('suppression d’un plan jamais souscrit : 200 + audit ; souscrit : 409 PLAN_UTILISE ; inconnu : 404', async () => {
    const libre = await creerPlan();
    expect((await api().delete(`${URL}/${libre.id}`).set(admin.h)).status).toBe(200);
    expect(await compter('audit_logs', "action = 'plan.suppression' AND entity_id = :id", { id: libre.id })).toBe(1);
    expect((await api().delete(`${URL}/${libre.id}`).set(admin.h)).status).toBe(404);

    const souscrit = await creerPlan();
    const p = await nouveauProprietaire();
    expect((await api().post(`/api/v1/admin/proprietaires/${p.ownerId}/abonnement/activer`).set(admin.h).send({ plan_code: souscrit.code, months: 1 })).status).toBe(201);
    const refus = await api().delete(`${URL}/${souscrit.id}`).set(admin.h);
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('PLAN_UTILISE');
  });

  test('plan désactivé : plus proposé à l’activation manuelle (422 PLAN_INDISPONIBLE)', async () => {
    const plan = await creerPlan();
    await api().post(`${URL}/${plan.id}/desactiver`).set(admin.h).send({});
    const p = await nouveauProprietaire();
    const res = await api().post(`/api/v1/admin/proprietaires/${p.ownerId}/abonnement/activer`).set(admin.h).send({ plan_code: plan.code, months: 1 });
    expect(res.status).toBe(422);
  });
});
