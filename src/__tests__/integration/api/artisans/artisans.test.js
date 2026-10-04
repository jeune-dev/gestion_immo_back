'use strict';

const crypto = require('crypto');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 24 Artisans : carnet du propriétaire, historique des interventions et
 * total dépensé, désactivation, suppression logique ; cloisonnement § 43.
 */
describe('Artisans', () => {
  let a;
  let b;
  let building;
  let apartment;
  let categorieTravaux;

  const creerArtisan = async (proprio, surcharges = {}) => {
    const res = await api().post('/api/v1/artisans').set(proprio.h)
      .send({ name: 'Mamadou Diop', phone: '77 123 45 67', trade: 'plombier', email: 'mdiop@test.sn', notes: 'Disponible le samedi', ...surcharges });
    expect(res.status).toBe(201);
    return res.body.data.contractor;
  };

  beforeAll(async () => {
    a = await nouveauProprietaire();
    b = await nouveauProprietaire();
    building = await creerImmeuble(a);
    apartment = await creerAppartement(a, building.id);
    const cats = await api().get('/api/v1/categories-depenses').set(a.h);
    categorieTravaux = cats.body.data.categories.find((c) => c.code === 'travaux');
  });
  afterAll(fermer);

  test('création : téléphone normalisé E.164, champs du § 24', async () => {
    const c = await creerArtisan(a);
    expect(c.phone).toBe('+221771234567');
    expect(c.trade).toBe('plombier');
    expect(c.is_active).toBe(true);
    expect(c.owner_id).toBe(a.ownerId);
  });

  test('validation : métier obligatoire et dans la liste (422)', async () => {
    expect((await api().post('/api/v1/artisans').set(a.h).send({ name: 'Sans métier' })).status).toBe(422);
    expect((await api().post('/api/v1/artisans').set(a.h).send({ name: 'X', trade: 'astronaute' })).status).toBe(422);
    expect((await api().post('/api/v1/artisans').set(a.h).send({ name: 'X', trade: 'peintre', phone: 'abc' })).status).toBe(422);
  });

  test('liste : filtre par métier et recherche, uniquement ses artisans', async () => {
    const nom = `Électricien ${crypto.randomBytes(3).toString('hex')}`;
    await creerArtisan(a, { name: nom, trade: 'electricien', phone: null, email: null });
    await creerArtisan(b, { name: nom, trade: 'electricien' });
    const res = await api().get('/api/v1/artisans').query({ trade: 'electricien', q: nom }).set(a.h);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ name: nom, interventions_count: 0, total_spent: 0 });
    const plombiers = await api().get('/api/v1/artisans').query({ trade: 'plombier' }).set(a.h);
    expect(plombiers.body.data.items.every((c) => c.trade === 'plombier')).toBe(true);
  });

  test('fiche : historique des interventions et total dépensé (dépenses valides)', async () => {
    const c = await creerArtisan(a);
    const wo = await api().post('/api/v1/travaux').set(a.h).send({
      title: 'Fuite cuisine', building_id: building.id, apartment_id: apartment.id, category: 'plomberie', contractor_id: c.id, estimated_amount: 80000,
    });
    expect(wo.status).toBe(201);
    const d1 = await api().post('/api/v1/depenses').set(a.h).send({
      amount: 100000, method: 'especes', spent_on: '2026-09-23', category_id: categorieTravaux.id, building_id: building.id, contractor_id: c.id,
    });
    const d2 = await api().post('/api/v1/depenses').set(a.h).send({
      amount: 5000, method: 'wave', spent_on: '2026-09-24', category_id: categorieTravaux.id, building_id: building.id, contractor_id: c.id,
    });
    expect(d1.status).toBe(201);
    await api().post(`/api/v1/depenses/${d2.body.data.expense.id}/annuler`).set(a.h).send({ reason: 'Saisie en double' });

    const res = await api().get(`/api/v1/artisans/${c.id}`).set(a.h);
    expect(res.status).toBe(200);
    expect(res.body.data.contractor.total_spent).toBe(100000);
    expect(res.body.data.contractor.interventions_count).toBe(1);
    expect(res.body.data.contractor.interventions[0]).toMatchObject({ title: 'Fuite cuisine', status: 'signale', reference: expect.stringMatching(/^#\d{5}$/) });
    expect(res.body.data.contractor.interventions[0].apartment.number).toBe(apartment.number);
  });

  test('modification, désactivation (409 si répétée) puis réactivation', async () => {
    const c = await creerArtisan(a);
    const modif = await api().patch(`/api/v1/artisans/${c.id}`).set(a.h).send({ notes: '', trade: 'macon' });
    expect(modif.status).toBe(200);
    expect(modif.body.data.contractor).toMatchObject({ trade: 'macon', notes: null });

    expect((await api().post(`/api/v1/artisans/${c.id}/desactiver`).set(a.h)).body.data.contractor.is_active).toBe(false);
    const encore = await api().post(`/api/v1/artisans/${c.id}/desactiver`).set(a.h);
    expect(encore.status).toBe(409);
    // Un artisan désactivé n'est plus proposé à l'affectation.
    const wo = await api().post('/api/v1/travaux').set(a.h).send({ title: 'Mur fissuré', building_id: building.id, category: 'maconnerie', contractor_id: c.id });
    expect(wo.status).toBe(409);
    expect(wo.body.error.code).toBe('ARTISAN_INACTIF');
    expect((await api().post(`/api/v1/artisans/${c.id}/reactiver`).set(a.h)).body.data.contractor.is_active).toBe(true);
  });

  test('suppression logique : refusée pendant un chantier en cours, puis 404', async () => {
    const c = await creerArtisan(a);
    const wo = await api().post('/api/v1/travaux').set(a.h).send({ title: 'Robinet', building_id: building.id, category: 'plomberie', status: 'valide' });
    const assigne = await api().post(`/api/v1/travaux/${wo.body.data.work_order.id}/statut`).set(a.h).send({ status: 'artisan_assigne', contractor_id: c.id });
    expect(assigne.status).toBe(200);
    const refus = await api().delete(`/api/v1/artisans/${c.id}`).set(a.h);
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('ARTISAN_TRAVAUX_EN_COURS');

    await api().post(`/api/v1/travaux/${wo.body.data.work_order.id}/statut`).set(a.h).send({ status: 'annule', comment: 'Réparé par le gardien' });
    expect((await api().delete(`/api/v1/artisans/${c.id}`).set(a.h)).status).toBe(200);
    expect((await api().get(`/api/v1/artisans/${c.id}`).set(a.h)).status).toBe(404);
    // Suppression LOGIQUE : la ligne existe toujours (historique § 42).
    const [[ligne]] = await sequelize.query('SELECT deleted_at FROM contractors WHERE id = :id', { replacements: { id: c.id } });
    expect(ligne.deleted_at).not.toBeNull();
  });

  test('cloisonnement : propriétaire B → 403 ; identifiant inconnu → 404', async () => {
    const c = await creerArtisan(a);
    expect((await api().get(`/api/v1/artisans/${c.id}`).set(b.h)).status).toBe(403);
    expect((await api().patch(`/api/v1/artisans/${c.id}`).set(b.h).send({ name: 'Pirate' })).status).toBe(403);
    expect((await api().post(`/api/v1/artisans/${c.id}/desactiver`).set(b.h)).status).toBe(403);
    expect((await api().delete(`/api/v1/artisans/${c.id}`).set(b.h)).status).toBe(403);
    expect((await api().get(`/api/v1/artisans/${crypto.randomUUID()}`).set(a.h)).status).toBe(404);
    // B ne peut pas affecter l'artisan de A à ses propres travaux.
    const bBuilding = await creerImmeuble(b);
    const wo = await api().post('/api/v1/travaux').set(b.h).send({ title: 'Test', building_id: bBuilding.id, category: 'plomberie', contractor_id: c.id });
    expect(wo.status).toBe(403);
  });
});
