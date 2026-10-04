'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 18 Travaux (workflow strict, historique), § 19 photos avant / pendant /
 * après, § 23 étape 7 dépense du chantier, § 41 immuabilité après clôture.
 */
describe('Travaux', () => {
  let a;
  let b;
  let building;
  let apartment;
  let artisan;
  let png;

  const creerTravaux = async (surcharges = {}) => {
    const res = await api().post('/api/v1/travaux').set(a.h).send({
      title: 'Fuite plomberie', description: 'Fuite sous l’évier', building_id: building.id, apartment_id: apartment.id,
      category: 'plomberie', priority: 'haute', estimated_amount: 90000, scheduled_for: '2026-10-01', ...surcharges,
    });
    expect(res.status).toBe(201);
    return res.body.data.work_order;
  };
  const statut = (id, corps, proprio = a) => api().post(`/api/v1/travaux/${id}/statut`).set(proprio.h).send(corps);

  beforeAll(async () => {
    a = await nouveauProprietaire();
    b = await nouveauProprietaire();
    building = await creerImmeuble(a);
    apartment = await creerAppartement(a, building.id, { number: 'A07' });
    artisan = (await api().post('/api/v1/artisans').set(a.h).send({ name: 'Mamadou Diop', trade: 'plombier' })).body.data.contractor;
    png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).png().toBuffer();
  });
  afterAll(fermer);

  test('création : numéro par propriétaire « #00001 », premier événement d’historique', async () => {
    const p = await nouveauProprietaire();
    const bat = await creerImmeuble(p);
    const r1 = await api().post('/api/v1/travaux').set(p.h).send({ title: 'Peinture hall', building_id: bat.id, category: 'peinture' });
    const r2 = await api().post('/api/v1/travaux').set(p.h).send({ title: 'Porte garage', building_id: bat.id, category: 'menuiserie' });
    expect(r1.status).toBe(201);
    expect(r1.body.data.work_order).toMatchObject({ number: 1, reference: '#00001', status: 'signale', priority: 'normale' });
    expect(r2.body.data.work_order.reference).toBe('#00002');

    const detail = await api().get(`/api/v1/travaux/${r1.body.data.work_order.id}`).set(p.h);
    expect(detail.body.data.work_order.events).toHaveLength(1);
    expect(detail.body.data.work_order.events[0]).toMatchObject({ from_status: null, to_status: 'signale' });
  });

  test('validation (422) : champs obligatoires, appartement d’un autre immeuble, statut initial', async () => {
    expect((await api().post('/api/v1/travaux').set(a.h).send({ building_id: building.id, category: 'plomberie' })).status).toBe(422);
    expect((await api().post('/api/v1/travaux').set(a.h).send({ title: 'X y', building_id: building.id, category: 'jardinage' })).status).toBe(422);
    expect((await api().post('/api/v1/travaux').set(a.h).send({ title: 'X y', building_id: building.id, category: 'plomberie', status: 'termine' })).status).toBe(422);
    const autre = await creerImmeuble(a);
    const res = await api().post('/api/v1/travaux').set(a.h).send({ title: 'Mauvais immeuble', building_id: autre.id, apartment_id: apartment.id, category: 'plomberie' });
    expect(res.status).toBe(422);
  });

  test('workflow complet : historique, audit, dépense du chantier, clôture puis immuabilité', async () => {
    const wo = await creerTravaux();
    // Transition absente de la table → 409.
    const saut = await statut(wo.id, { status: 'en_cours' });
    expect(saut.status).toBe(409);
    expect(saut.body.error.code).toBe('TRANSITION_INVALIDE');

    expect((await statut(wo.id, { status: 'valide', comment: 'Devis accepté' })).status).toBe(200);
    // Assignation sans artisan → 422.
    expect((await statut(wo.id, { status: 'artisan_assigne' })).status).toBe(422);
    const assigne = await statut(wo.id, { status: 'artisan_assigne', contractor_id: artisan.id });
    expect(assigne.status).toBe(200);
    expect(assigne.body.data.work_order.contractor.name).toBe('Mamadou Diop');
    const enCours = await statut(wo.id, { status: 'en_cours' });
    expect(enCours.body.data.work_order.started_at).not.toBeNull();

    // § 23 étape 7 : immeuble, appartement et artisan repris du chantier ; catégorie « travaux ».
    const dep = await api().post(`/api/v1/travaux/${wo.id}/depenses`).set(a.h).send({ amount: 100000, method: 'especes', spent_on: '2026-09-23' });
    expect(dep.status).toBe(201);
    expect(dep.body.data.expense).toMatchObject({
      building_id: building.id, apartment_id: apartment.id, contractor_id: artisan.id, work_order_id: wo.id, category: { code: 'travaux' },
    });
    const [[mvt]] = await sequelize.query("SELECT category, amount FROM cash_movements WHERE source_type = 'expense' AND source_id = :id", { replacements: { id: dep.body.data.expense.id } });
    expect(mvt).toMatchObject({ category: 'travaux', amount: 100000 });

    const fin = await statut(wo.id, { status: 'termine', actual_amount: 100000, comment: 'Joint remplacé' });
    expect(fin.status).toBe(200);
    expect(fin.body.data.work_order).toMatchObject({ status: 'termine', actual_amount: 100000 });
    expect(fin.body.data.work_order.completed_at).not.toBeNull();

    const detail = (await api().get(`/api/v1/travaux/${wo.id}`).set(a.h)).body.data.work_order;
    expect(detail.events.map((e) => e.to_status)).toEqual(['signale', 'valide', 'artisan_assigne', 'en_cours', 'termine']);
    expect(detail.events[4].comment).toBe('Joint remplacé');
    expect(detail.expenses).toHaveLength(1);
    expect(detail.total_expenses).toBe(100000);
    const [[{ n }]] = await sequelize.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'travaux.changement_statut' AND entity_id = :id", { replacements: { id: wo.id } });
    expect(n).toBe(4);

    // Immuable (§ 41).
    const patch = await api().patch(`/api/v1/travaux/${wo.id}`).set(a.h).send({ title: 'Réécriture' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('TRAVAUX_CLOTURES');
    expect((await statut(wo.id, { status: 'annule', comment: 'Trop tard' })).status).toBe(409);
    expect((await statut(wo.id, { status: 'en_cours' })).body.error.code).toBe('TRANSITION_INVALIDE');
  });

  test('annulation : motif obligatoire, puis immuable ; dépense refusée sur travaux annulés', async () => {
    const wo = await creerTravaux();
    expect((await statut(wo.id, { status: 'annule' })).status).toBe(422);
    const res = await statut(wo.id, { status: 'annule', comment: 'Doublon' });
    expect(res.status).toBe(200);
    expect(res.body.data.work_order).toMatchObject({ status: 'annule', cancel_reason: 'Doublon' });
    expect((await api().patch(`/api/v1/travaux/${wo.id}`).set(a.h).send({ priority: 'basse' })).status).toBe(409);
    const dep = await api().post(`/api/v1/travaux/${wo.id}/depenses`).set(a.h).send({ amount: 1000, method: 'especes', spent_on: '2026-09-23' });
    expect(dep.status).toBe(409);
  });

  test('modification d’un travail ouvert ; appartement hors immeuble refusé', async () => {
    const wo = await creerTravaux();
    const res = await api().patch(`/api/v1/travaux/${wo.id}`).set(a.h).send({ priority: 'urgente', estimated_amount: 120000, scheduled_for: '2026-10-05' });
    expect(res.status).toBe(200);
    expect(res.body.data.work_order).toMatchObject({ priority: 'urgente', estimated_amount: 120000, scheduled_for: '2026-10-05' });
    const autreApt = await creerAppartement(a, (await creerImmeuble(a)).id);
    expect((await api().patch(`/api/v1/travaux/${wo.id}`).set(a.h).send({ apartment_id: autreApt.id })).status).toBe(422);
    expect((await api().patch(`/api/v1/travaux/${wo.id}`).set(a.h).send({ status: 'termine' })).status).toBe(422);
  });

  test('photos avant / pendant / après : regroupées par phase ; verrouillées après clôture', async () => {
    const wo = await creerTravaux({ status: 'valide' });
    const envoyer = (phase, legende) => api().post(`/api/v1/travaux/${wo.id}/photos`).set(a.h)
      .field('phase', phase).field('caption', legende).field('captured_at', '2026-09-23T10:00:00.000Z')
      .attach('fichier', png, 'photo.png');
    const avant = await envoyer('avant', 'Fuite visible');
    expect(avant.status).toBe(201);
    expect(avant.body.data.photo).toMatchObject({ phase: 'avant', caption: 'Fuite visible' });
    expect(avant.body.data.photo.document).toMatchObject({ category: 'photo', has_thumbnail: true });
    expect((await envoyer('pendant', 'Démontage')).status).toBe(201);
    const erreur = await envoyer('apres', 'Mauvaise photo');
    expect((await envoyer('pendant2', 'x')).status).toBe(422);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    expect((await api().post(`/api/v1/travaux/${wo.id}/photos`).set(a.h).field('phase', 'avant').attach('fichier', pdf, 'x.pdf')).status).toBe(400);

    // Retrait possible tant que le chantier est ouvert.
    expect((await api().delete(`/api/v1/travaux/${wo.id}/photos/${erreur.body.data.photo.id}`).set(a.h)).status).toBe(200);
    expect((await api().delete(`/api/v1/travaux/${wo.id}/photos/${crypto.randomUUID()}`).set(a.h)).status).toBe(404);
    expect((await envoyer('apres', 'Réparé')).status).toBe(201);

    const photos = (await api().get(`/api/v1/travaux/${wo.id}/photos`).set(a.h)).body.data.photos;
    expect(photos.avant).toHaveLength(1);
    expect(photos.pendant).toHaveLength(1);
    expect(photos.apres).toHaveLength(1);
    expect(photos.apres[0].caption).toBe('Réparé');
    expect(photos.avant[0].document.url).toMatch(/^\/api\/v1\/documents\/.+\/fichier$/);

    await statut(wo.id, { status: 'en_cours' });
    await statut(wo.id, { status: 'termine' });
    const refus = await api().delete(`/api/v1/travaux/${wo.id}/photos/${photos.avant[0].id}`).set(a.h);
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('PHOTOS_VERROUILLEES');
    const detail = (await api().get(`/api/v1/travaux/${wo.id}`).set(a.h)).body.data.work_order;
    expect(detail.photos.avant).toHaveLength(1);
  });

  test('liste : filtres statut, priorité, artisan, recherche, période', async () => {
    const p = await nouveauProprietaire();
    const bat = await creerImmeuble(p);
    const art = (await api().post('/api/v1/artisans').set(p.h).send({ name: 'Awa Fall', trade: 'electricien' })).body.data.contractor;
    await api().post('/api/v1/travaux').set(p.h).send({ title: 'Câblage compteur', building_id: bat.id, category: 'electricite', priority: 'urgente', contractor_id: art.id });
    await api().post('/api/v1/travaux').set(p.h).send({ title: 'Peinture façade', building_id: bat.id, category: 'peinture', status: 'valide' });

    const q = await api().get('/api/v1/travaux').query({ q: 'câblage' }).set(p.h);
    expect(q.body.data.items).toHaveLength(1);
    expect(q.body.data.items[0]).toMatchObject({ reference: '#00001', contractor: { name: 'Awa Fall' }, building: { name: bat.name } });
    expect((await api().get('/api/v1/travaux').query({ status: 'valide' }).set(p.h)).body.data.pagination.total).toBe(1);
    expect((await api().get('/api/v1/travaux').query({ priority: 'urgente' }).set(p.h)).body.data.pagination.total).toBe(1);
    expect((await api().get('/api/v1/travaux').query({ contractor_id: art.id }).set(p.h)).body.data.pagination.total).toBe(1);
    expect((await api().get('/api/v1/travaux').query({ du: '2000-01-01', au: '2000-12-31' }).set(p.h)).body.data.pagination.total).toBe(0);
    const jour = new Date().toISOString().slice(0, 10);
    expect((await api().get('/api/v1/travaux').query({ du: jour, au: jour }).set(p.h)).body.data.pagination.total).toBe(2);
    expect((await api().get('/api/v1/travaux').query({ status: 'fini' }).set(p.h)).status).toBe(422);
  });

  test('cloisonnement : propriétaire B → 403 partout ; inconnu → 404', async () => {
    const wo = await creerTravaux();
    expect((await api().get(`/api/v1/travaux/${wo.id}`).set(b.h)).status).toBe(403);
    expect((await api().patch(`/api/v1/travaux/${wo.id}`).set(b.h).send({ title: 'Pirate' })).status).toBe(403);
    expect((await statut(wo.id, { status: 'valide' }, b)).status).toBe(403);
    expect((await api().get(`/api/v1/travaux/${wo.id}/photos`).set(b.h)).status).toBe(403);
    expect((await api().post(`/api/v1/travaux/${wo.id}/photos`).set(b.h).field('phase', 'avant').attach('fichier', png, 'p.png')).status).toBe(403);
    expect((await api().post(`/api/v1/travaux/${wo.id}/depenses`).set(b.h).send({ amount: 1000, method: 'especes', spent_on: '2026-09-23' })).status).toBe(403);
    expect((await api().post('/api/v1/travaux').set(b.h).send({ title: 'Chez A', building_id: building.id, category: 'plomberie' })).status).toBe(403);
    expect((await api().get(`/api/v1/travaux/${crypto.randomUUID()}`).set(a.h)).status).toBe(404);
    expect((await statut(crypto.randomUUID(), { status: 'valide' })).status).toBe(404);
  });
});
