'use strict';

const crypto = require('crypto');
const {
  api, superAdmin, nouveauProprietaire, creerImmeuble, creerLocataire, bailActif, compter, fermer,
} = require('../../../setup/helpers.js');

/**
 * § 29 / § 30 vues transverses (propriétaires, locataires, immeubles,
 * signalements) et § 31 abonnements / paiements vus par le Super Admin.
 */

const BASE = '/api/v1/admin';
const INCONNU = '00000000-0000-4000-8000-000000000000';

let admin;
beforeAll(async () => { admin = await superAdmin(); });
afterAll(fermer);

const abonnementDe = async (ownerId) => {
  const res = await api().get(`${BASE}/abonnements`).query({ owner_id: ownerId }).set(admin.h);
  return res.body.data.items[0];
};

describe('Propriétaires', () => {
  test('recherche (nom unique avec jokers), statut, tri, pagination exacte', async () => {
    const suffixe = crypto.randomBytes(3).toString('hex');
    const p = await nouveauProprietaire({ first_name: 'Ndeye', last_name: `Z_${suffixe}%` });
    const res = await api().get(`${BASE}/proprietaires`).query({ q: `Z_${suffixe}%` }).set(admin.h);
    expect(res.body.data.items.map((o) => o.id)).toEqual([p.ownerId]);
    expect(res.body.data.items[0]).toMatchObject({ titulaire: { id: p.user.id }, subscription_status: 'essai', tenants_count: 0 });
    expect(res.body.data.items[0]).not.toHaveProperty('settings');
    const total = await compter('owners', 'deleted_at IS NULL');
    const page = await api().get(`${BASE}/proprietaires`).query({ limit: 3, page: 2, tri: 'display_name' }).set(admin.h);
    expect(page.body.data.pagination).toEqual({ page: 2, limit: 3, total, totalPages: Math.ceil(total / 3) });
  });

  test('filtre « aucun abonnement » et « suspendu »', async () => {
    const sans = await nouveauProprietaire();
    await api().post(`${BASE}/abonnements/${(await abonnementDe(sans.ownerId)).id}/annuler`).set(admin.h).send({});
    const suspendu = await nouveauProprietaire();
    await api().post(`${BASE}/abonnements/${(await abonnementDe(suspendu.ownerId)).id}/suspendre`).set(admin.h).send({ reason: 'Impayé' });
    const aucun = await api().get(`${BASE}/proprietaires`).query({ abonnement: 'aucun', limit: 100 }).set(admin.h);
    expect(aucun.body.data.items.map((o) => o.id)).toContain(sans.ownerId);
    expect(aucun.body.data.items.map((o) => o.id)).not.toContain(suspendu.ownerId);
    const susp = await api().get(`${BASE}/proprietaires`).query({ abonnement: 'suspendu', limit: 100 }).set(admin.h);
    expect(susp.body.data.items.map((o) => o.id)).toContain(suspendu.ownerId);
    expect(susp.body.data.items.every((o) => o.subscription_status === 'suspendu')).toBe(true);
  });

  test('injection SQL dans la recherche et le plan : aucune fuite', async () => {
    const avant = await compter('owners');
    for (const query of [{ q: "' OR 1=1 --" }, { plan: "X' OR '1'='1" }, { q: "'; DROP TABLE owners; --" }]) {
      const res = await api().get(`${BASE}/proprietaires`).query(query).set(admin.h);
      expect([200, 422]).toContain(res.status);
      if (res.status === 200) expect(res.body.data.items).toEqual([]);
    }
    expect(await compter('owners')).toBe(avant);
  });

  test.each([
    ['statut inconnu', { status: 'banni' }], ['abonnement inconnu', { abonnement: 'gratuit' }], ['tri inconnu', { tri: 'email' }],
    ['plan de 31 caractères', { plan: 'P'.repeat(31) }], ['page 0', { page: 0 }],
  ])('paramètre invalide 422 : %s', async (_l, query) => {
    expect((await api().get(`${BASE}/proprietaires`).query(query).set(admin.h)).status).toBe(422);
  });

  test('détail : activité, membres, abonnement ; réglages non exposés ; 404 / 422', async () => {
    const p = await nouveauProprietaire();
    await bailActif(p);
    await api().patch('/api/v1/parametres').set(p.h).send({ late_grace_days: 2 });
    const res = await api().get(`${BASE}/proprietaires/${p.ownerId}`).set(admin.h);
    expect(res.status).toBe(200);
    expect(res.body.data.owner).toMatchObject({
      activity: { apartments_occupied: 1, active_leases: 1, open_incidents: 0 },
      members: [{ role_code: 'proprietaire', user: { id: p.user.id } }],
      settings_customized: true,
      buildings_count: 1,
    });
    expect(res.body.data.owner).not.toHaveProperty('settings');
    expect((await api().get(`${BASE}/proprietaires/${INCONNU}`).set(admin.h)).status).toBe(404);
    expect((await api().get(`${BASE}/proprietaires/abc`).set(admin.h)).status).toBe(422);
  });

  test('suspension puis réactivation : notification au propriétaire, audit ; 404 inconnu', async () => {
    const p = await nouveauProprietaire();
    expect((await api().post(`${BASE}/proprietaires/${p.ownerId}/suspendre`).set(admin.h).send({ reason: 'Contrôle' })).status).toBe(200);
    expect((await api().post(`${BASE}/proprietaires/${p.ownerId}/reactiver`).set(admin.h).send({})).status).toBe(200);
    expect(await compter('notifications', "user_id = :u AND title = 'Espace réactivé'", { u: p.user.id })).toBe(1);
    expect(await compter('audit_logs', "action = 'proprietaire.changement_statut' AND entity_id = :o", { o: p.ownerId })).toBe(2);
    expect((await api().post(`${BASE}/proprietaires/${INCONNU}/suspendre`).set(admin.h).send({ reason: 'Motif' })).status).toBe(404);
    expect((await api().post(`${BASE}/proprietaires/${INCONNU}/reactiver`).set(admin.h).send({})).status).toBe(404);
  });
});

describe('Locataires, immeubles, signalements (vues minimales)', () => {
  test('locataires : filtre propriétaire, recherche nom complet, aucune donnée sensible', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p, { first_name: 'Khady', last_name: 'Sy', notes: 'NOTE_PRIVEE', id_document_type: 'cni', id_document_number: 'PIECE_SECRETE' });
    const res = await api().get(`${BASE}/locataires`).query({ owner_id: p.ownerId, q: 'Khady Sy' }).set(admin.h);
    expect(res.body.data.items.map((x) => x.id)).toEqual([t.id]);
    expect(res.body.data.items[0]).toMatchObject({ has_account: false, active_leases: 0 });
    expect(JSON.stringify(res.body)).not.toMatch(/NOTE_PRIVEE|PIECE_SECRETE|id_document|email/);
    expect((await api().get(`${BASE}/locataires`).query({ owner_id: 'x' }).set(admin.h)).status).toBe(422);
    expect((await api().get(`${BASE}/locataires`).query({ q: "' OR 1=1 --", owner_id: p.ownerId }).set(admin.h)).body.data.items).toEqual([]);
  });

  test('immeubles : filtres propriétaire, ville, recherche ; compteurs', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p, { city: 'Ziguinchor' });
    const res = await api().get(`${BASE}/immeubles`).query({ owner_id: p.ownerId, city: 'Ziguinchor', q: b.name.slice(-6) }).set(admin.h);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ id: b.id, apartments_count: 0, occupied_count: 0, owner: { id: p.ownerId } });
    expect(res.body.data.items[0]).not.toHaveProperty('description');
    expect((await api().get(`${BASE}/immeubles`).query({ tri: 'owner_id' }).set(admin.h)).status).toBe(422);
  });

  test('signalements : liste et statistiques cohérentes ; filtres invalides 422', async () => {
    const liste = await api().get(`${BASE}/signalements`).query({ limit: 1 }).set(admin.h);
    expect(liste.status).toBe(200);
    const stats = await api().get(`${BASE}/signalements/statistiques`).set(admin.h);
    expect(stats.body.data.statistiques.total).toBe(liste.body.data.pagination.total);
    for (const query of [{ status: 'inconnu' }, { category: 'meteo' }, { du: '31-12-2026' }, { owner_id: '1' }]) {
      expect((await api().get(`${BASE}/signalements`).query(query).set(admin.h)).status).toBe(422);
      expect((await api().get(`${BASE}/signalements/statistiques`).query(query).set(admin.h)).status).toBe(422);
    }
    const vide = await api().get(`${BASE}/signalements/statistiques`).query({ du: '2099-01-01' }).set(admin.h);
    expect(vide.body.data.statistiques).toEqual({ total: 0, by_status: {}, by_category: {} });
  });
});

describe('Abonnements', () => {
  test('liste : filtres statut, plan, propriétaire, échéance ; 422 sur filtre invalide', async () => {
    const p = await nouveauProprietaire();
    const essais = await api().get(`${BASE}/abonnements`).query({ status: 'essai', plan: 'business', owner_id: p.ownerId }).set(admin.h);
    expect(essais.body.data.items).toHaveLength(1);
    expect(essais.body.data.items[0]).toMatchObject({ status: 'essai', plan: { code: 'BUSINESS' }, owner: { id: p.ownerId } });
    const avant2000 = await api().get(`${BASE}/abonnements`).query({ fin_avant: '2000-01-01', owner_id: p.ownerId }).set(admin.h);
    expect(avant2000.body.data.items).toEqual([]);
    for (const query of [{ status: 'gratuit' }, { owner_id: 'x' }, { fin_avant: 'demain' }, { tri: 'price' }]) {
      expect((await api().get(`${BASE}/abonnements`).query(query).set(admin.h)).status).toBe(422);
    }
  });

  test('transitions interdites : réactiver un essai, suspendre un abonnement annulé → 409 ; motif obligatoire', async () => {
    const p = await nouveauProprietaire();
    const a = await abonnementDe(p.ownerId);
    const url = `${BASE}/abonnements/${a.id}`;
    expect((await api().post(`${url}/reactiver`).set(admin.h).send({})).body.error.code).toBe('TRANSITION_INTERDITE');
    expect((await api().post(`${url}/suspendre`).set(admin.h).send({})).status).toBe(422);
    expect((await api().post(`${url}/annuler`).set(admin.h).send({ reason: 'ab' })).status).toBe(422);
    expect((await api().post(`${url}/annuler`).set(admin.h).send({})).status).toBe(200);
    expect((await api().post(`${url}/suspendre`).set(admin.h).send({ reason: 'Trop tard' })).status).toBe(409);
    expect((await api().post(`${url}/annuler`).set(admin.h).send({})).status).toBe(409);
    expect(await compter('audit_logs', "action = 'abonnement.changement_statut' AND entity_id = :id", { id: a.id })).toBe(1);
    for (const action of ['suspendre', 'reactiver', 'annuler']) {
      expect((await api().post(`${BASE}/abonnements/${INCONNU}/${action}`).set(admin.h).send({ reason: 'Motif valable' })).status).toBe(404);
    }
    expect((await api().get(`${BASE}/abonnements/${INCONNU}`).set(admin.h)).status).toBe(404);
  });

  test('activation manuelle : abonnement payé, paiement « manuel », audit, écriture rouverte', async () => {
    const p = await nouveauProprietaire();
    await api().post(`${BASE}/abonnements/${(await abonnementDe(p.ownerId)).id}/annuler`).set(admin.h).send({});
    expect((await api().post('/api/v1/immeubles').set(p.h).send({ name: 'R', address: 'A', city: 'Dakar' })).status).toBe(402);
    const res = await api().post(`${BASE}/proprietaires/${p.ownerId}/abonnement/activer`).set(admin.h).send({ plan_code: 'pro', months: 3, amount: 90000, note: 'Remise' });
    expect(res.status).toBe(201);
    expect(res.body.data.payment).toMatchObject({ provider: 'manuel', months: 3, status: 'confirme', recorded_by: admin.user.id });
    expect(Number(res.body.data.payment.amount)).toBe(90000);
    expect(res.body.data.subscription.status).toBe('actif');
    expect(await compter('audit_logs', "action = 'abonnement.paiement' AND owner_id = :o", { o: p.ownerId })).toBe(1);
    expect((await api().post('/api/v1/immeubles').set(p.h).send({ name: 'R', address: 'A', city: 'Dakar' })).status).toBe(201);
    const paiements = await api().get(`${BASE}/paiements`).query({ owner_id: p.ownerId, status: 'confirme', provider: 'manuel' }).set(admin.h);
    expect(paiements.body.data.items).toHaveLength(1);
  });

  test.each([
    ['plan manquant', { months: 1 }],
    ['0 mois', { plan_code: 'PRO', months: 0 }],
    ['25 mois', { plan_code: 'PRO', months: 25 }],
    ['montant négatif', { plan_code: 'PRO', months: 1, amount: -5 }],
    ['note de 1001 caractères', { plan_code: 'PRO', months: 1, note: 'n'.repeat(1001) }],
  ])('activation manuelle 422 : %s', async (_l, corps) => {
    const p = await nouveauProprietaire();
    expect((await api().post(`${BASE}/proprietaires/${p.ownerId}/abonnement/activer`).set(admin.h).send(corps)).status).toBe(422);
    expect(await compter('subscription_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
  });

  test('activation manuelle : plan inconnu 422, propriétaire inconnu 404, identifiant invalide 422', async () => {
    const p = await nouveauProprietaire();
    expect((await api().post(`${BASE}/proprietaires/${p.ownerId}/abonnement/activer`).set(admin.h).send({ plan_code: 'INEXISTANT', months: 1 })).status).toBe(422);
    expect((await api().post(`${BASE}/proprietaires/${INCONNU}/abonnement/activer`).set(admin.h).send({ plan_code: 'PRO', months: 1 })).status).toBe(404);
    expect((await api().post(`${BASE}/proprietaires/abc/abonnement/activer`).set(admin.h).send({ plan_code: 'PRO', months: 1 })).status).toBe(422);
  });

  test('paiements et statistiques des loyers : filtres invalides 422, période vide', async () => {
    for (const query of [{ provider: 'wave' }, { status: 'x' }, { du: '2026-13-01' }, { tri: 'owner_id' }]) {
      expect((await api().get(`${BASE}/paiements`).query(query).set(admin.h)).status).toBe(422);
    }
    expect((await api().get(`${BASE}/paiements/loyers/statistiques`).query({ au: 'hier' }).set(admin.h)).status).toBe(422);
    const vide = await api().get(`${BASE}/paiements/loyers/statistiques`).query({ du: '2001-01-01', au: '2001-12-31' }).set(admin.h);
    expect(vide.body.data.statistiques).toMatchObject({ period: { start: '2001-01-01', end: '2001-12-31' }, rent_payments: { by_month: [], by_method: {} }, transactions: [] });
  });
});

describe('Tableau de bord', () => {
  test('forme stable ; taux d’occupation borné', async () => {
    const res = await api().get(`${BASE}/dashboard`).set(admin.h);
    expect(res.status).toBe(200);
    const d = res.body.data.dashboard;
    expect(d.apartments.occupancy_rate).toBeGreaterThanOrEqual(0);
    expect(d.apartments.occupancy_rate).toBeLessThanOrEqual(100);
    expect(d).toHaveProperty('generated_at');
  });
});
