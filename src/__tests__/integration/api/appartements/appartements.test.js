'use strict';

const crypto = require('crypto');
const {
  api, nouveauProprietaire, superAdmin, proprietaireEtLocataire, creerImmeuble, creerAppartement, bailActif,
  payerEspeces, expirerAbonnement, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 8 Appartements — CRUD, statuts (§ 41 « occupé » exige un bail actif),
 * historique (§ 25), rentabilité (§ 4.21), contrôle d'accès, limites (§ 31).
 */

const URL = '/api/v1/appartements';
const INCONNU = '00000000-0000-4000-8000-000000000000';
const numero = () => `N${crypto.randomBytes(3).toString('hex')}`;

afterAll(fermer);

describe('Création', () => {
  test('nominal : 201, statut « disponible » imposé, owner_id de l’appelant, audit', async () => {
    const p = await nouveauProprietaire();
    const autre = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    const corps = {
      building_id: b.id, number: 'A12', floor: 2, type: 'f3', surface: 85.5, rooms_count: 4, rent_amount: 350000,
      charges_amount: 15000, charge_coefficient: 1.5, is_furnished: true, description: 'Balcon',
    };
    const res = await api().post(URL).set(p.h).send({ ...corps, status: 'occupe', owner_id: autre.ownerId });
    expect(res.status).toBe(201);
    const a = res.body.data.apartment;
    expect(a).toMatchObject({ building_id: b.id, number: 'A12', floor: 2, type: 'f3', rooms_count: 4, is_furnished: true, status: 'disponible', owner_id: p.ownerId });
    expect(Number(a.rent_amount)).toBe(350000);
    expect(Number(a.surface)).toBe(85.5);
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'appartement.creation' AND entity_id = :id", { replacements: { id: a.id } });
    expect(audit.details).toMatchObject({ number: 'A12', building_id: b.id });
  });

  test('immeuble d’un autre propriétaire : 403 ; immeuble inconnu : 422 ; aucune ligne créée', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const immeubleA = await creerImmeuble(a);
    const autre = await api().post(URL).set(b.h).send({ building_id: immeubleA.id, number: '1', type: 'studio', rent_amount: 100000 });
    expect(autre.status).toBe(403);
    const inconnu = await api().post(URL).set(b.h).send({ building_id: INCONNU, number: '1', type: 'studio', rent_amount: 100000 });
    expect(inconnu.status).toBe(422);
    expect(await compter('apartments', 'building_id = :b', { b: immeubleA.id })).toBe(0);
  });

  test('numéro en double dans le même immeuble (casse différente) : 409 ; dans un autre immeuble : permis', async () => {
    const p = await nouveauProprietaire();
    const b1 = await creerImmeuble(p);
    const b2 = await creerImmeuble(p);
    await creerAppartement(p, b1.id, { number: 'B4' });
    const doublon = await api().post(URL).set(p.h).send({ building_id: b1.id, number: 'b4', type: 'f2', rent_amount: 1 });
    expect(doublon.status).toBe(409);
    expect((await api().post(URL).set(p.h).send({ building_id: b2.id, number: 'B4', type: 'f2', rent_amount: 1 })).status).toBe(201);
  });

  test.each([
    ['immeuble manquant', { building_id: undefined }],
    ['immeuble non UUID', { building_id: 'abc' }],
    ['numéro manquant', { number: undefined }],
    ['numéro de 31 caractères', { number: 'n'.repeat(31) }],
    ['type manquant', { type: undefined }],
    ['type inconnu', { type: 'chateau' }],
    ['loyer manquant', { rent_amount: undefined }],
    ['loyer négatif', { rent_amount: -1 }],
    ['loyer décimal', { rent_amount: 1000.5 }],
    ['loyer non numérique', { rent_amount: 'beaucoup' }],
    ['loyer démesuré', { rent_amount: 1e13 }],
    ['charges négatives', { charges_amount: -500 }],
    ['surface négative', { surface: -10 }],
    ['étage -6', { floor: -6 }],
    ['coefficient nul', { charge_coefficient: 0 }],
    ['pièces non entières', { rooms_count: 2.5 }],
    ['meublé non booléen', { is_furnished: 'peut-être' }],
  ])('validation 422 : %s', async (_l, surcharge) => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    const corps = { building_id: b.id, number: numero(), type: 'f2', rent_amount: 200000, ...surcharge };
    for (const [cle, valeur] of Object.entries(surcharge)) if (valeur === undefined) delete corps[cle];
    expect((await api().post(URL).set(p.h).send(corps)).status).toBe(422);
    expect(await compter('apartments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
  });
});

describe('Lecture, modification, suppression', () => {
  test('détail : occupation, locataire actuel, historique des baux, documents', async () => {
    const p = await nouveauProprietaire();
    const { apartment, tenant, lease } = await bailActif(p);
    const res = await api().get(`${URL}/${apartment.id}`).set(p.h);
    expect(res.status).toBe(200);
    const a = res.body.data.apartment;
    expect(a).toMatchObject({ status: 'occupe', current_lease: { id: lease.id }, current_tenant: { id: tenant.id }, documents: [] });
    expect(a.tenant_history.map((l) => l.id)).toEqual([lease.id]);
    expect(a.current_lease.tenant).toBeUndefined();
  });

  test('modification du loyer : action d’audit « modification_loyer » ; autre champ : « modification » ; building_id ignoré', async () => {
    const p = await nouveauProprietaire();
    const b1 = await creerImmeuble(p);
    const b2 = await creerImmeuble(p);
    const a = await creerAppartement(p, b1.id);
    const loyer = await api().patch(`${URL}/${a.id}`).set(p.h).send({ rent_amount: 400000, building_id: b2.id });
    expect(loyer.status).toBe(200);
    expect(loyer.body.data.apartment.building_id).toBe(b1.id);
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'appartement.modification_loyer' AND entity_id = :id", { replacements: { id: a.id } });
    expect(audit.details.rent_amount).toEqual({ avant: 350000, apres: 400000 });
    await api().patch(`${URL}/${a.id}`).set(p.h).send({ description: 'Refait à neuf' });
    expect(await compter('audit_logs', "action = 'appartement.modification' AND entity_id = :id", { id: a.id })).toBe(1);
  });

  test('modification : corps vide, statut, numéro en double → refusés', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    const a1 = await creerAppartement(p, b.id);
    const a2 = await creerAppartement(p, b.id);
    expect((await api().patch(`${URL}/${a1.id}`).set(p.h).send({})).status).toBe(422);
    // Le statut ne passe pas par la modification générale.
    expect((await api().patch(`${URL}/${a1.id}`).set(p.h).send({ status: 'occupe' })).status).toBe(422);
    expect((await api().patch(`${URL}/${a1.id}`).set(p.h).send({ number: a2.number })).status).toBe(409);
  });

  test('suppression : logique + audit ; refusée avec un historique de bail (409)', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    const a = await creerAppartement(p, b.id);
    expect((await api().delete(`${URL}/${a.id}`).set(p.h)).status).toBe(200);
    expect(await compter('apartments', 'id = :id AND deleted_at IS NOT NULL', { id: a.id })).toBe(1);
    expect(await compter('audit_logs', "action = 'appartement.suppression' AND entity_id = :id", { id: a.id })).toBe(1);
    expect((await api().get(`${URL}/${a.id}`).set(p.h)).status).toBe(404);

    const { apartment } = await bailActif(p);
    const refus = await api().delete(`${URL}/${apartment.id}`).set(p.h);
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('APPARTEMENT_AVEC_HISTORIQUE');
  });
});

describe('Statut (§ 8, § 41)', () => {
  test('changements manuels permis et journalisés', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    const a = await creerAppartement(p, b.id);
    for (const status of ['en_travaux', 'indisponible', 'disponible']) {
      const res = await api().patch(`${URL}/${a.id}/statut`).set(p.h).send({ status });
      expect(res.status).toBe(200);
      expect(res.body.data.apartment.status).toBe(status);
    }
    const [lignes] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'appartement.changement_statut' AND entity_id = :id ORDER BY created_at", { replacements: { id: a.id } });
    expect(lignes.map((l) => l.details.apres)).toEqual(['en_travaux', 'indisponible', 'disponible']);
  });

  test('« occupé » ne se pose jamais à la main : 422', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    const a = await creerAppartement(p, b.id);
    for (const status of ['occupe', 'inconnu', '']) expect((await api().patch(`${URL}/${a.id}/statut`).set(p.h).send({ status })).status).toBe(422);
    expect((await api().patch(`${URL}/${a.id}/statut`).set(p.h).send({})).status).toBe(422);
  });

  test('bail actif : statut verrouillé sur « occupé » (409 APPARTEMENT_OCCUPE)', async () => {
    const p = await nouveauProprietaire();
    const { apartment } = await bailActif(p);
    const res = await api().patch(`${URL}/${apartment.id}/statut`).set(p.h).send({ status: 'disponible' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPARTEMENT_OCCUPE');
    const [[ligne]] = await sequelize.query('SELECT status FROM apartments WHERE id = :id', { replacements: { id: apartment.id } });
    expect(ligne.status).toBe('occupe');
  });
});

describe('Historique et rentabilité', () => {
  test('historique : loyer payé visible, filtre de période, pagination', async () => {
    const p = await nouveauProprietaire();
    const { apartment, lease } = await bailActif(p);
    await payerEspeces(p, lease.id, 350000, { paidOn: '2026-09-05' });
    const res = await api().get(`${URL}/${apartment.id}/historique`).set(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'loyer_paye', ressource_type: 'rent_payment' })]));
    expect(res.body.data.pagination).toMatchObject({ page: 1, limit: 30, total: res.body.data.items.length });
    const avant = await api().get(`${URL}/${apartment.id}/historique`).query({ au: '2026-01-01' }).set(p.h);
    expect(avant.body.data).toEqual({ items: [], pagination: { page: 1, limit: 30, total: 0, totalPages: 1 } });
    expect((await api().get(`${URL}/${apartment.id}/historique`).query({ du: '2026-02-30x' }).set(p.h)).status).toBe(422);
    expect((await api().get(`${URL}/${apartment.id}/historique`).query({ page: 0 }).set(p.h)).status).toBe(422);
  });

  test('rentabilité : loyers encaissés, résultat net ; dates obligatoires', async () => {
    const p = await nouveauProprietaire();
    const { apartment, lease } = await bailActif(p);
    await payerEspeces(p, lease.id, 350000, { paidOn: '2026-09-05' });
    const res = await api().get(`${URL}/${apartment.id}/rentabilite`).query({ du: '2026-09-01', au: '2026-09-30' }).set(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data.rentabilite).toMatchObject({
      apartment: { id: apartment.id }, periode: { du: '2026-09-01', au: '2026-09-30' },
      loyers_encaisses: 350000, depenses: 0, resultat_net: 350000,
    });
    expect((await api().get(`${URL}/${apartment.id}/rentabilite`).set(p.h)).status).toBe(422);
    expect((await api().get(`${URL}/${apartment.id}/rentabilite`).query({ du: '2026-09-01' }).set(p.h)).status).toBe(422);
  });
});

describe('Contrôle d’accès', () => {
  test('appartement d’un autre propriétaire : toutes les routes → 403, base inchangée', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const immeuble = await creerImmeuble(a);
    const appart = await creerAppartement(a, immeuble.id);
    const url = `${URL}/${appart.id}`;
    for (const [methode, chemin, corps, query] of [
      ['get', url], ['patch', url, { rent_amount: 1 }], ['patch', `${url}/statut`, { status: 'indisponible' }], ['delete', url],
      ['get', `${url}/historique`], ['get', `${url}/rentabilite`, undefined, { du: '2026-01-01', au: '2026-12-31' }],
    ]) {
      const res = await api()[methode](chemin).query(query || {}).set(b.h).send(corps);
      expect({ chemin, statut: res.status }).toEqual({ chemin, statut: 403 });
    }
    const [[ligne]] = await sequelize.query('SELECT rent_amount, status, deleted_at FROM apartments WHERE id = :id', { replacements: { id: appart.id } });
    expect(ligne).toEqual({ rent_amount: 350000, status: 'disponible', deleted_at: null });
    expect((await api().get(URL).query({ building_id: immeuble.id }).set(b.h)).body.data.items).toEqual([]);
  });

  test('404 inconnu et 422 identifiant invalide', async () => {
    const p = await nouveauProprietaire();
    expect((await api().get(`${URL}/${INCONNU}`).set(p.h)).status).toBe(404);
    expect((await api().patch(`${URL}/${INCONNU}/statut`).set(p.h).send({ status: 'disponible' })).status).toBe(404);
    expect((await api().get(`${URL}/12`).set(p.h)).status).toBe(422);
  });

  test('locataire et super admin : 403 ; abonnement échu : écriture 402', async () => {
    const { proprio, locataire, apartment } = await proprietaireEtLocataire();
    const admin = await superAdmin();
    for (const h of [locataire.h, admin.h]) {
      expect((await api().get(URL).set(h)).status).toBe(403);
      expect((await api().get(`${URL}/${apartment.id}`).set(h)).status).toBe(403);
    }
    await expirerAbonnement(proprio.ownerId);
    expect((await api().get(`${URL}/${apartment.id}`).set(proprio.h)).status).toBe(200);
    expect((await api().patch(`${URL}/${apartment.id}`).set(proprio.h).send({ description: 'x' })).status).toBe(402);
  });
});

describe('Liste', () => {
  let p; let b1; let b2;
  beforeAll(async () => {
    p = await nouveauProprietaire();
    b1 = await creerImmeuble(p);
    b2 = await creerImmeuble(p);
    await creerAppartement(p, b1.id, { number: 'A1', type: 'studio', rent_amount: 100000, description: 'Vue 100% mer' });
    await creerAppartement(p, b1.id, { number: 'A2', type: 'f3', rent_amount: 300000 });
    await creerAppartement(p, b1.id, { number: 'A_3', type: 'f3', rent_amount: 200000 });
    const d = await creerAppartement(p, b2.id, { number: 'B1', type: 'villa', rent_amount: 900000 });
    await api().patch(`${URL}/${d.id}/statut`).set(p.h).send({ status: 'en_travaux' });
  });

  test('filtres immeuble, statut, type', async () => {
    const parImmeuble = await api().get(URL).query({ building_id: b1.id }).set(p.h);
    expect(parImmeuble.body.data.pagination.total).toBe(3);
    const travaux = await api().get(URL).query({ status: 'en_travaux' }).set(p.h);
    expect(travaux.body.data.items.map((a) => a.number)).toEqual(['B1']);
    const f3 = await api().get(URL).query({ type: 'f3' }).set(p.h);
    expect(f3.body.data.items.map((a) => a.number).sort()).toEqual(['A2', 'A_3']);
    expect(f3.body.data.items[0]).toMatchObject({ building: { id: b1.id }, current_lease: null, current_tenant: null });
  });

  test('tri par loyer (croissant, décroissant) et pagination exacte', async () => {
    const asc = await api().get(URL).query({ tri: 'rent_amount' }).set(p.h);
    expect(asc.body.data.items.map((a) => Number(a.rent_amount))).toEqual([100000, 200000, 300000, 900000]);
    const desc = await api().get(URL).query({ tri: '-rent_amount', limit: 3, page: 2 }).set(p.h);
    expect(desc.body.data.items.map((a) => Number(a.rent_amount))).toEqual([100000]);
    expect(desc.body.data.pagination).toEqual({ page: 2, limit: 3, total: 4, totalPages: 2 });
  });

  test('recherche : jokers littéraux, injection SQL sans effet', async () => {
    expect((await api().get(URL).query({ q: '_' }).set(p.h)).body.data.items.map((a) => a.number)).toEqual(['A_3']);
    expect((await api().get(URL).query({ q: '100%' }).set(p.h)).body.data.items.map((a) => a.number)).toEqual(['A1']);
    const avant = await compter('apartments');
    for (const q of ["' OR 1=1 --", "'; DROP TABLE apartments; --"]) {
      const res = await api().get(URL).query({ q }).set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    }
    expect(await compter('apartments')).toBe(avant);
  });

  test.each([
    ['statut inconnu', { status: 'vendu' }], ['type inconnu', { type: 'yourte' }], ['immeuble non UUID', { building_id: 'x' }],
    ['tri inconnu', { tri: 'owner_id' }], ['page 0', { page: 0 }], ['limit -5', { limit: -5 }],
  ])('paramètre invalide 422 : %s', async (_l, query) => {
    expect((await api().get(URL).query(query).set(p.h)).status).toBe(422);
  });
});

describe('Limite de la formule (§ 31)', () => {
  test('concurrence : 5 créations simultanées avec max_apartments = 2 → exactement 2', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    const admin = await superAdmin();
    const code = `APT_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    await api().post('/api/v1/admin/plans').set(admin.h).send({ code, name: 'Deux appartements', price: 1000, max_buildings: 5, max_apartments: 2 });
    expect((await api().post(`/api/v1/admin/proprietaires/${p.ownerId}/abonnement/activer`).set(admin.h).send({ plan_code: code, months: 1 })).status).toBe(201);
    const reponses = await Promise.all(Array.from({ length: 5 }, () => api().post(URL).set(p.h)
      .send({ building_id: b.id, number: numero(), type: 'f2', rent_amount: 1000 })));
    expect(reponses.filter((r) => r.status === 201)).toHaveLength(2);
    expect(reponses.filter((r) => r.status === 403).every((r) => r.body.error.code === 'LIMITE_ABONNEMENT')).toBe(true);
    expect(await compter('apartments', 'owner_id = :o AND deleted_at IS NULL', { o: p.ownerId })).toBe(2);
  });
});
