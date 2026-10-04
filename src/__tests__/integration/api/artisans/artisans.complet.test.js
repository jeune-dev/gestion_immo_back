'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, creerImmeuble, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');

/**
 * Artisans (§ 24) : carnet d'adresses, historique des interventions et total
 * dépensé, désactivation / réactivation, suppression LOGIQUE (§ 42) refusée
 * pendant un chantier en cours. Couverture complète des routes /artisans.
 */

jest.setTimeout(90000);

const A = '/api/v1/artisans';
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

afterAll(fermer);

describe('Artisans — couverture complète', () => {
  let p;
  let autre;
  let bat;

  const creer = async (surcharges = {}, proprio = p) => {
    const res = await api().post(A).set(proprio.h).send({ name: 'Abdou Kane', trade: 'plombier', ...surcharges });
    expect(res.status).toBe(201);
    return res.body.data.contractor;
  };
  const travaux = async (artisan, statut = 'valide') => {
    const wo = (await api().post('/api/v1/travaux').set(p.h).send({ title: 'Intervention', building_id: bat.id, category: 'plomberie', status: 'valide' })).body.data.work_order;
    if (statut !== 'valide') {
      await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'artisan_assigne', contractor_id: artisan.id });
      if (statut === 'en_cours' || statut === 'termine') await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'en_cours' });
      if (statut === 'termine') await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'termine' });
    } else {
      await api().patch(`/api/v1/travaux/${wo.id}`).set(p.h).send({ contractor_id: artisan.id });
    }
    return wo;
  };
  const depense = (artisan, montant, extra = {}) => api().post('/api/v1/depenses').set(p.h).send({
    amount: montant, method: 'especes', spent_on: '2026-09-10', building_id: bat.id, contractor_id: artisan.id,
    category_id: extra.category_id, ...extra,
  });

  let catTravaux;
  beforeAll(async () => {
    p = await nouveauProprietaire();
    autre = await nouveauProprietaire();
    bat = await creerImmeuble(p);
    catTravaux = (await api().get('/api/v1/categories-depenses').set(p.h)).body.data.categories.find((c) => c.code === 'travaux');
  });

  describe('création et validation', () => {
    test('201 : téléphone normalisé, e-mail en minuscules, champs vides → null, actif, audit ; champs protégés ignorés', async () => {
      const res = await api().post(A).set(p.h).send({
        name: '  Awa Ndiaye ', trade: 'electricien', phone: '77 123 45 67', email: ' AWA@Exemple.SN ', notes: '', owner_id: autre.ownerId, is_active: false,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.contractor).toMatchObject({
        name: 'Awa Ndiaye', trade: 'electricien', phone: '+221771234567', email: 'awa@exemple.sn', notes: null, is_active: true, owner_id: p.ownerId,
      });
      expect(await compter('audit_logs', "action = 'artisan.creation' AND entity_id = :id", { id: res.body.data.contractor.id })).toBe(1);
    });

    test.each([
      ['corps vide', {}],
      ['nom manquant', { name: undefined }],
      ['nom vide', { name: '   ' }],
      ['nom trop long', { name: 'x'.repeat(151) }],
      ['métier manquant', { trade: undefined }],
      ['métier inconnu', { trade: 'astronaute' }],
      ['téléphone invalide', { phone: 'abc' }],
      ['téléphone trop long', { phone: '1'.repeat(26) }],
      ['e-mail invalide', { email: 'pas-un-email' }],
      ['notes trop longues', { notes: 'x'.repeat(2001) }],
      ['nom non texte', { name: 12 }],
    ])('%s → 422, rien d’écrit', async (_cas, surcharges) => {
      const envoi = Object.keys(surcharges).length ? { name: 'Nom valide', trade: 'macon', ...surcharges } : {};
      for (const [k, v] of Object.entries(envoi)) if (v === undefined) delete envoi[k];
      const avant = await compter('contractors', 'owner_id = :o', { o: p.ownerId });
      expect((await api().post(A).set(p.h).send(envoi)).status).toBe(422);
      expect(await compter('contractors', 'owner_id = :o', { o: p.ownerId })).toBe(avant);
    });
  });

  describe('§ 24 — historique des interventions et total dépensé', () => {
    test('fiche : interventions (plus récentes d’abord, référence #), total et nombre des dépenses VALIDES seulement', async () => {
      const art = await creer({ name: 'Historique' });
      const w1 = await travaux(art, 'termine');
      const w2 = await travaux(art, 'valide');
      await depense(art, 40000, { category_id: catTravaux.id, work_order_id: w1.id });
      await depense(art, 15000, { category_id: catTravaux.id });
      const annulee = (await depense(art, 99999, { category_id: catTravaux.id })).body.data.expense;
      await api().post(`/api/v1/depenses/${annulee.id}/annuler`).set(p.h).send({ reason: 'Erreur' });

      const res = await api().get(`${A}/${art.id}`).set(p.h);
      expect(res.status).toBe(200);
      const c = res.body.data.contractor;
      expect(c).toMatchObject({ total_spent: 55000, expenses_count: 2, interventions_count: 2 });
      expect(c.interventions.map((w) => w.id)).toEqual([w2.id, w1.id]);
      expect(c.interventions[1]).toMatchObject({ status: 'termine', reference: expect.stringMatching(/^#\d{5}$/), building: { id: bat.id } });

      // Mêmes chiffres dans la liste (sous-requêtes corrélées).
      const liste = await api().get(A).query({ q: 'Historique' }).set(p.h);
      expect(liste.body.data.items[0]).toMatchObject({ id: art.id, interventions_count: 2, total_spent: 55000 });
    });

    test('artisan sans intervention : zéros', async () => {
      const art = await creer({ name: 'Nouveau venu' });
      const c = (await api().get(`${A}/${art.id}`).set(p.h)).body.data.contractor;
      expect(c).toMatchObject({ total_spent: 0, expenses_count: 0, interventions_count: 0, interventions: [] });
    });
  });

  describe('liste : pagination, filtres, recherche, tri', () => {
    let proprio;
    let arts;
    beforeAll(async () => {
      proprio = await nouveauProprietaire();
      arts = [
        await creer({ name: 'Bamba 100%', trade: 'macon', phone: '+221770000001' }, proprio),
        await creer({ name: 'Coumba_Fall', trade: 'peintre', email: 'coumba@test.sn' }, proprio),
        await creer({ name: 'Aliou', trade: 'macon' }, proprio),
      ];
      await api().post(`${A}/${arts[2].id}/desactiver`).set(proprio.h);
    });
    const liste = (query) => api().get(A).query(query).set(proprio.h);
    const noms = async (query) => (await liste(query)).body.data.items.map((c) => c.name);

    test('tri par défaut : nom ; tri métier / date ; invalide 422', async () => {
      expect(await noms({})).toEqual(['Aliou', 'Bamba 100%', 'Coumba_Fall']);
      expect(await noms({ tri: '-name' })).toEqual(['Coumba_Fall', 'Bamba 100%', 'Aliou']);
      expect((await noms({ tri: 'trade' }))[2]).toBe('Coumba_Fall');
      expect(await noms({ tri: 'created_at' })).toEqual(['Bamba 100%', 'Coumba_Fall', 'Aliou']);
      for (const query of [{ tri: 'phone' }, { tri: 'owner_id' }, { trade: 'x' }, { is_active: 'oui-non' }, { page: 0 }, { limit: 0 }, { q: 'x'.repeat(101) }]) {
        expect([query, (await liste(query)).status]).toEqual([query, 422]);
      }
    });

    test('filtres métier et activité ; recherche nom / téléphone / e-mail, jokers échappés, injections inoffensives', async () => {
      expect(await noms({ trade: 'macon' })).toEqual(['Aliou', 'Bamba 100%']);
      expect(await noms({ is_active: false })).toEqual(['Aliou']);
      expect(await noms({ is_active: true })).toEqual(['Bamba 100%', 'Coumba_Fall']);
      expect(await noms({ q: '100%' })).toEqual(['Bamba 100%']);
      expect(await noms({ q: 'a_f' })).toEqual(['Coumba_Fall']);
      expect(await noms({ q: '0000001' })).toEqual(['Bamba 100%']);
      expect(await noms({ q: 'COUMBA@' })).toEqual(['Coumba_Fall']);
      for (const terme of ["'; DROP TABLE contractors; --", "' OR '1'='1", '%%', '\\']) {
        const res = await liste({ q: terme });
        expect(res.status).toBe(200);
        expect(res.body.data.items.every((c) => c.owner_id === proprio.ownerId)).toBe(true);
      }
      expect(await compter('contractors', 'owner_id = :o', { o: proprio.ownerId })).toBe(3);
    });

    test('pages, au-delà, plafond, totaux exacts ; liste vide pour un nouveau propriétaire', async () => {
      const p2 = await liste({ limit: 2, page: 2 });
      expect(p2.body.data.items.map((c) => c.name)).toEqual(['Coumba_Fall']);
      expect(p2.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect((await liste({ page: 3, limit: 2 })).body.data.items).toEqual([]);
      expect((await liste({ limit: 1000 })).body.data.pagination.limit).toBe(100);
      expect((await api().get(A).set((await nouveauProprietaire()).h)).body.data.pagination.total).toBe(0);
    });
  });

  describe('modification, activité, suppression', () => {
    test('modification : champs, normalisation, audit ; vide 422 ; autre propriétaire 403 inchangé ; inconnu 404', async () => {
      const art = await creer();
      const res = await api().patch(`${A}/${art.id}`).set(p.h).send({ phone: '+221 76 000 00 00', notes: 'Disponible le samedi', email: '', is_active: false });
      expect(res.status).toBe(200);
      expect(res.body.data.contractor).toMatchObject({ phone: '+221760000000', notes: 'Disponible le samedi', email: null, is_active: true });
      expect(await compter('audit_logs', "action = 'artisan.modification' AND entity_id = :id", { id: art.id })).toBe(1);
      expect((await api().patch(`${A}/${art.id}`).set(p.h).send({})).status).toBe(422);
      expect((await api().patch(`${A}/${art.id}`).set(p.h).send({ trade: 'astronaute' })).status).toBe(422);
      const [avant] = await q('SELECT * FROM contractors WHERE id = :id', { id: art.id });
      expect((await api().patch(`${A}/${art.id}`).set(autre.h).send({ name: 'Pirate' })).status).toBe(403);
      expect((await q('SELECT * FROM contractors WHERE id = :id', { id: art.id }))[0]).toEqual(avant);
      expect((await api().patch(`${A}/${crypto.randomUUID()}`).set(p.h).send({ name: 'X' })).status).toBe(404);
      expect((await api().patch(`${A}/abc`).set(p.h).send({ name: 'X' })).status).toBe(422);
    });

    test('désactiver / réactiver : 200 + audit, répétition 409 (codes stables), autre propriétaire 403', async () => {
      const art = await creer();
      expect((await api().post(`${A}/${art.id}/reactiver`).set(p.h)).body.error.code).toBe('ARTISAN_DEJA_ACTIF');
      expect((await api().post(`${A}/${art.id}/desactiver`).set(autre.h)).status).toBe(403);
      const d = await api().post(`${A}/${art.id}/desactiver`).set(p.h);
      expect(d.status).toBe(200);
      expect(d.body.data.contractor.is_active).toBe(false);
      expect((await api().post(`${A}/${art.id}/desactiver`).set(p.h)).body.error.code).toBe('ARTISAN_DEJA_INACTIF');
      // Désactivé : plus proposable à l'affectation de travaux (409).
      const wo = (await api().post('/api/v1/travaux').set(p.h).send({ title: 'Test', building_id: bat.id, category: 'autre', status: 'valide' })).body.data.work_order;
      expect((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'artisan_assigne', contractor_id: art.id })).status).toBe(409);
      expect((await api().post(`${A}/${art.id}/reactiver`).set(p.h)).status).toBe(200);
      expect(await compter('audit_logs', "action = 'artisan.changement_statut' AND entity_id = :id", { id: art.id })).toBe(2);
      expect((await api().post(`${A}/${crypto.randomUUID()}/reactiver`).set(p.h)).status).toBe(404);
    });

    test.each([['artisan_assigne'], ['en_cours']])('suppression refusée pendant un chantier « %s » (409), acceptée ensuite ; logique ; historique conservé', async (etat) => {
      const art = await creer({ name: `À supprimer ${etat}` });
      const wo = await travaux(art, etat);
      const refus = await api().delete(`${A}/${art.id}`).set(p.h);
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('ARTISAN_TRAVAUX_EN_COURS');
      if (etat === 'en_cours') await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'termine' });
      else await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'annule', comment: 'Abandon' });
      expect((await api().delete(`${A}/${art.id}`).set(p.h)).status).toBe(200);
      // Suppression LOGIQUE : ligne conservée, date de suppression posée, audit.
      expect(await compter('contractors', 'id = :id AND deleted_at IS NOT NULL', { id: art.id })).toBe(1);
      expect(await compter('audit_logs', "action = 'artisan.suppression' AND entity_id = :id", { id: art.id })).toBe(1);
      expect((await api().get(`${A}/${art.id}`).set(p.h)).status).toBe(404);
      expect((await api().get(A).set(p.h)).body.data.items.map((c) => c.id)).not.toContain(art.id);
      // Le chantier garde son artisan (historique § 24, § 41).
      const detail = (await api().get(`/api/v1/travaux/${wo.id}`).set(p.h)).body.data.work_order;
      expect(detail.contractor).toMatchObject({ id: art.id, name: `À supprimer ${etat}` });
      expect((await api().delete(`${A}/${art.id}`).set(p.h)).status).toBe(404);
    });

    test('suppressions simultanées : une seule réussit ; autre propriétaire 403 sans effet', async () => {
      const art = await creer();
      expect((await api().delete(`${A}/${art.id}`).set(autre.h)).status).toBe(403);
      expect(await compter('contractors', 'id = :id AND deleted_at IS NULL', { id: art.id })).toBe(1);
      const reponses = await Promise.all([1, 2, 3].map(() => api().delete(`${A}/${art.id}`).set(p.h)));
      expect(reponses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(reponses.filter((r) => r.status !== 200).every((r) => r.status === 404)).toBe(true);
      expect(await compter('audit_logs', "action = 'artisan.suppression' AND entity_id = :id", { id: art.id })).toBe(1);
    });

    test('lecture d’un artisan d’autrui : 403 ; absent de sa liste', async () => {
      const art = await creer();
      expect((await api().get(`${A}/${art.id}`).set(autre.h)).status).toBe(403);
      expect((await api().get(A).set(autre.h)).body.data.items.map((c) => c.id)).not.toContain(art.id);
    });
  });
});
