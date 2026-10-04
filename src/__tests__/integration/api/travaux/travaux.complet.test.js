'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, pngTest, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const { TRAVAUX } = require('../../../../config/transitions.js');

/**
 * Travaux (§ 18) — matrice COMPLÈTE des transitions de config/transitions.js,
 * historique (work_order_events) et audit de chaque transition, immuabilité
 * d'un travail clos (§ 41) ; photos avant / pendant / après (§ 19) ; dépense
 * du chantier (§ 23 étape 7) ; validation, pagination, filtres, concurrence.
 */

jest.setTimeout(120000);

const T = '/api/v1/travaux';
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const STATUTS = Object.keys(TRAVAUX);

afterAll(fermer);

describe('Travaux — couverture complète', () => {
  let p;
  let autre;
  let bat;
  let apt;
  let artisan;
  let artisanInactif;

  const creer = async (surcharges = {}, proprio = p) => {
    const res = await api().post(T).set(proprio.h).send({ title: 'Réparation porte', building_id: bat.id, category: 'menuiserie', ...surcharges });
    expect(res.status).toBe(201);
    return res.body.data.work_order;
  };
  /** Place un travail directement dans un statut (préparation de la matrice). */
  const placer = async (statut) => {
    const wo = await creer({ contractor_id: artisan.id });
    await q('UPDATE work_orders SET status = :s WHERE id = :id', { s: statut, id: wo.id });
    return wo;
  };
  const statut = (id, corps, proprio = p) => api().post(`${T}/${id}/statut`).set(proprio.h).send(corps);
  const evenements = (id) => q('SELECT from_status, to_status, comment, user_id FROM work_order_events WHERE work_order_id = :id ORDER BY created_at, id', { id });

  beforeAll(async () => {
    p = await nouveauProprietaire();
    autre = await nouveauProprietaire();
    bat = await creerImmeuble(p, { name: 'Immeuble Thiès' });
    apt = await creerAppartement(p, bat.id, { number: 'T1' });
    artisan = (await api().post('/api/v1/artisans').set(p.h).send({ name: 'Ibrahima Ba', trade: 'menuisier' })).body.data.contractor;
    artisanInactif = (await api().post('/api/v1/artisans').set(p.h).send({ name: 'Inactif', trade: 'macon' })).body.data.contractor;
    await api().post(`/api/v1/artisans/${artisanInactif.id}/desactiver`).set(p.h);
  });

  describe('G — matrice des transitions (§ 18)', () => {
    const cas = [];
    for (const de of STATUTS) for (const vers of STATUTS) cas.push([de, vers, TRAVAUX[de].includes(vers)]);

    test.each(cas)('%s → %s : permise = %s', async (de, vers, permise) => {
      const wo = await placer(de);
      const avant = await evenements(wo.id);
      const corps = { status: vers, comment: 'Motif de la transition' };
      if (vers === 'artisan_assigne') corps.contractor_id = artisan.id;
      const res = await statut(wo.id, corps);
      const apres = await evenements(wo.id);
      const [ligne] = await q('SELECT status, started_at, completed_at, cancelled_at, cancel_reason FROM work_orders WHERE id = :id', { id: wo.id });
      if (permise) {
        expect(res.status).toBe(200);
        expect(res.body.data.work_order.status).toBe(vers);
        expect(apres).toHaveLength(avant.length + 1);
        expect(apres[apres.length - 1]).toMatchObject({ from_status: de, to_status: vers, comment: 'Motif de la transition', user_id: p.user.id });
        expect(await compter('audit_logs', "action = 'travaux.changement_statut' AND entity_id = :id", { id: wo.id })).toBe(1);
        if (vers === 'en_cours') expect(ligne.started_at).not.toBeNull();
        if (vers === 'termine') expect(ligne.completed_at).not.toBeNull();
        if (vers === 'annule') expect(ligne).toMatchObject({ cancel_reason: 'Motif de la transition', cancelled_at: expect.anything() });
      } else {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('TRANSITION_INVALIDE');
        expect(ligne.status).toBe(de);
        expect(apres).toHaveLength(avant.length);
        expect(await compter('audit_logs', "action = 'travaux.changement_statut' AND entity_id = :id", { id: wo.id })).toBe(0);
      }
    });

    test('statut inconnu → 422 ; assignation sans artisan (aucun rattaché) → 422 ; artisan inactif → 409 ARTISAN_INACTIF', async () => {
      const wo = await creer({ status: 'valide' });
      expect((await statut(wo.id, { status: 'fini' })).status).toBe(422);
      expect((await statut(wo.id, {})).status).toBe(422);
      expect((await statut(wo.id, { status: 'artisan_assigne' })).status).toBe(422);
      const inactif = await statut(wo.id, { status: 'artisan_assigne', contractor_id: artisanInactif.id });
      expect(inactif.status).toBe(409);
      expect(inactif.body.error.code).toBe('ARTISAN_INACTIF');
      const autreArtisan = (await api().post('/api/v1/artisans').set(autre.h).send({ name: 'Autre', trade: 'macon' })).body.data.contractor;
      expect((await statut(wo.id, { status: 'artisan_assigne', contractor_id: autreArtisan.id })).status).toBe(403);
      expect((await statut(wo.id, { status: 'artisan_assigne', contractor_id: crypto.randomUUID() })).status).toBe(422);
      expect((await q('SELECT status FROM work_orders WHERE id = :id', { id: wo.id }))[0].status).toBe('valide');
    });

    test('annulation sans motif → 422 ; montant réel à la clôture ; montant négatif → 422', async () => {
      const wo = await placer('en_cours');
      expect((await statut(wo.id, { status: 'annule' })).status).toBe(422);
      expect((await statut(wo.id, { status: 'termine', actual_amount: -1 })).status).toBe(422);
      const fin = await statut(wo.id, { status: 'termine', actual_amount: 87500 });
      expect(fin.body.data.work_order).toMatchObject({ status: 'termine', actual_amount: 87500 });
    });

    test('parcours complet : 5 événements, dates de début/fin, travail terminé IMMUABLE (modification, retrait de photo, transition)', async () => {
      const wo = await creer();
      for (const [vers, extra] of [['a_valider', {}], ['valide', {}], ['artisan_assigne', { contractor_id: artisan.id }], ['en_cours', {}], ['termine', { actual_amount: 1000 }]]) {
        expect((await statut(wo.id, { status: vers, ...extra })).status).toBe(200);
      }
      const hist = await evenements(wo.id);
      expect(hist.map((e) => e.to_status)).toEqual(['signale', 'a_valider', 'valide', 'artisan_assigne', 'en_cours', 'termine']);
      expect(hist[0]).toMatchObject({ from_status: null, comment: 'Création' });
      const patch = await api().patch(`${T}/${wo.id}`).set(p.h).send({ title: 'Réécriture de l’histoire' });
      expect(patch.status).toBe(409);
      expect(patch.body.error.code).toBe('TRAVAUX_CLOTURES');
      for (const vers of STATUTS) expect((await statut(wo.id, { status: vers, comment: 'x', contractor_id: artisan.id })).status).toBe(409);
      expect(await evenements(wo.id)).toHaveLength(6);
    });
  });

  describe('I — concurrence', () => {
    test('deux transitions SIMULTANÉES depuis « validé » (en cours / annulé) → une seule gagne, historique cohérent', async () => {
      const wo = await creer({ status: 'valide' });
      const [r1, r2] = await Promise.all([
        statut(wo.id, { status: 'en_cours' }),
        statut(wo.id, { status: 'annule', comment: 'Course' }),
      ]);
      const statuts = [r1.status, r2.status].sort();
      const [final] = await q('SELECT status FROM work_orders WHERE id = :id', { id: wo.id });
      const hist = await evenements(wo.id);
      // Soit l'une gagne et l'autre est refusée ; soit en_cours puis annule (transition permise) — jamais d'état incohérent.
      if (statuts[1] === 409) {
        expect(statuts).toEqual([200, 409]);
        expect(hist).toHaveLength(2);
        expect(hist[1].to_status).toBe(final.status);
      } else {
        expect(final.status).toBe('annule');
        expect(hist.map((e) => e.to_status)).toEqual(['valide', 'en_cours', 'annule']);
      }
      for (let i = 1; i < hist.length; i += 1) expect(hist[i].from_status).toBe(hist[i - 1].to_status);
    });

    test('cinq « terminer » simultanés → un seul 200, un seul événement « termine », une seule notification d’audit', async () => {
      const wo = await placer('en_cours');
      const reponses = await Promise.all([1, 2, 3, 4, 5].map(() => statut(wo.id, { status: 'termine' })));
      expect(reponses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(reponses.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await compter('work_order_events', "work_order_id = :id AND to_status = 'termine'", { id: wo.id })).toBe(1);
      expect(await compter('audit_logs', "action = 'travaux.changement_statut' AND entity_id = :id", { id: wo.id })).toBe(1);
    });

    test('créations simultanées : numéros distincts et consécutifs par propriétaire', async () => {
      const proprio = await nouveauProprietaire();
      const b = await creerImmeuble(proprio);
      const reponses = await Promise.all([1, 2, 3, 4].map((i) => api().post(T).set(proprio.h).send({ title: `Chantier ${i}`, building_id: b.id, category: 'autre' })));
      expect(reponses.every((r) => r.status === 201)).toBe(true);
      expect(reponses.map((r) => r.body.data.work_order.number).sort()).toEqual([1, 2, 3, 4]);
    });
  });

  describe('A/D — création, détail, modification', () => {
    test('création : 201, forme, référence, champs protégés ignorés, audit ; artisan et appartement vérifiés', async () => {
      const res = await api().post(T).set(p.h).send({
        title: 'Fuite toiture', description: '', building_id: bat.id, apartment_id: apt.id, category: 'maconnerie', priority: 'urgente',
        estimated_amount: 150000, contractor_id: artisan.id, scheduled_for: '2026-10-10', status: 'a_valider',
        owner_id: autre.ownerId, number: 999, completed_at: '2020-01-01', actual_amount: 5,
      });
      expect(res.status).toBe(201);
      const wo = res.body.data.work_order;
      expect(wo).toMatchObject({
        owner_id: p.ownerId, status: 'a_valider', priority: 'urgente', description: null, estimated_amount: 150000, actual_amount: null,
        completed_at: null, reference: expect.stringMatching(/^#\d{5}$/), building: { name: 'Immeuble Thiès' }, apartment: { number: 'T1' },
        contractor: { name: 'Ibrahima Ba' },
      });
      expect(wo.number).not.toBe(999);
      expect(await compter('audit_logs', "action = 'travaux.creation' AND entity_id = :id", { id: wo.id })).toBe(1);
      expect((await api().post(T).set(p.h).send({ title: 'Inactif', building_id: bat.id, category: 'autre', contractor_id: artisanInactif.id })).status).toBe(409);
    });

    test.each([
      ['corps vide', {}],
      ['titre manquant', { title: undefined }],
      ['titre trop court', { title: 'x' }],
      ['titre trop long', { title: 'x'.repeat(151) }],
      ['description trop longue', { description: 'x'.repeat(5001) }],
      ['catégorie manquante', { category: undefined }],
      ['catégorie inconnue', { category: 'jardinage' }],
      ['priorité inconnue', { priority: 'critique' }],
      ['statut initial interdit', { status: 'en_cours' }],
      ['montant estimé négatif', { estimated_amount: -1 }],
      ['montant estimé décimal', { estimated_amount: 10.5 }],
      ['date prévue inexistante', { scheduled_for: '2026-02-29' }],
      ['immeuble non UUID', { building_id: 'x' }],
      ['immeuble inconnu', { building_id: crypto.randomUUID() }],
      ['artisan inconnu', { contractor_id: crypto.randomUUID() }],
    ])('création — %s → 422, rien d’écrit', async (_cas, surcharges) => {
      const envoi = Object.keys(surcharges).length ? { title: 'Titre valide', building_id: bat.id, category: 'autre', ...surcharges } : {};
      for (const [k, v] of Object.entries(envoi)) if (v === undefined) delete envoi[k];
      const avant = await compter('work_orders', 'owner_id = :o', { o: p.ownerId });
      expect((await api().post(T).set(p.h).send(envoi)).status).toBe(422);
      expect(await compter('work_orders', 'owner_id = :o', { o: p.ownerId })).toBe(avant);
    });

    test('détail : historique, photos groupées, dépenses et total des dépenses VALIDES', async () => {
      const wo = await creer({ status: 'valide', contractor_id: artisan.id });
      const d1 = (await api().post(`${T}/${wo.id}/depenses`).set(p.h).send({ amount: 30000, method: 'especes', spent_on: '2026-09-20' })).body.data.expense;
      await api().post(`${T}/${wo.id}/depenses`).set(p.h).send({ amount: 5000, method: 'wave', spent_on: '2026-09-21' });
      await api().post(`/api/v1/depenses/${d1.id}/annuler`).set(p.h).send({ reason: 'Erreur' });
      const res = await api().get(`${T}/${wo.id}`).set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.work_order).toMatchObject({
        events: [expect.objectContaining({ to_status: 'valide' })], photos: { avant: [], pendant: [], apres: [] }, total_expenses: 5000,
      });
      expect(res.body.data.work_order.expenses).toHaveLength(2);
    });

    test('modification : champs, audit ; retrait de l’artisan d’un travail assigné → 422 ; immeuble non modifiable', async () => {
      const wo = await creer({ status: 'valide' });
      const res = await api().patch(`${T}/${wo.id}`).set(p.h).send({ priority: 'basse', apartment_id: apt.id, scheduled_for: null, building_id: crypto.randomUUID() });
      expect(res.status).toBe(200);
      expect(res.body.data.work_order).toMatchObject({ priority: 'basse', apartment_id: apt.id, building_id: bat.id });
      expect(await compter('audit_logs', "action = 'travaux.modification' AND entity_id = :id", { id: wo.id })).toBe(1);
      await statut(wo.id, { status: 'artisan_assigne', contractor_id: artisan.id });
      expect((await api().patch(`${T}/${wo.id}`).set(p.h).send({ contractor_id: null })).status).toBe(422);
      expect((await api().patch(`${T}/${wo.id}`).set(p.h).send({})).status).toBe(422);
      expect((await api().patch(`${T}/${wo.id}`).set(p.h).send({ contractor_id: artisanInactif.id })).status).toBe(409);
      expect((await q('SELECT contractor_id FROM work_orders WHERE id = :id', { id: wo.id }))[0].contractor_id).toBe(artisan.id);
    });
  });

  describe('§ 19 — photos avant / pendant / après', () => {
    const envoyer = (id, phase, fichier, nomFichier = 'photo.png', extra = {}) => {
      let r = api().post(`${T}/${id}/photos`).set(p.h).field('phase', phase);
      for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
      return r.attach('fichier', fichier, nomFichier);
    };

    test('chaque phase : 201, document « photo » + ligne work_photos, horodatages client et serveur conservés', async () => {
      const wo = await creer({ status: 'valide' });
      const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00f' } }).jpeg().toBuffer();
      const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0f0' } }).webp().toBuffer();
      const r1 = await envoyer(wo.id, 'avant', await pngTest(), 'a.png', { caption: 'État initial', captured_at: '2026-09-20T08:00:00.000Z' });
      const r2 = await envoyer(wo.id, 'pendant', jpg, 'b.jpg');
      const r3 = await envoyer(wo.id, 'apres', webp, 'c.webp');
      for (const r of [r1, r2, r3]) expect(r.status).toBe(201);
      expect(r1.body.data.photo).toMatchObject({ phase: 'avant', caption: 'État initial', captured_at: '2026-09-20T08:00:00.000Z', document: { category: 'photo' } });
      expect(r2.body.data.photo.document.mime_type).toBe('image/jpeg');
      expect(r3.body.data.photo.document.mime_type).toBe('image/webp');
      const lignes = await q('SELECT wp.phase, d.category, d.entity_id FROM work_photos wp JOIN documents d ON d.id = wp.document_id WHERE wp.work_order_id = :id ORDER BY wp.created_at', { id: wo.id });
      expect(lignes.map((l) => l.phase)).toEqual(['avant', 'pendant', 'apres']);
      expect(lignes.every((l) => l.category === 'photo' && l.entity_id === wo.id)).toBe(true);
      const liste = await api().get(`${T}/${wo.id}/photos`).set(p.h);
      expect(liste.status).toBe(200);
      expect(Object.fromEntries(Object.entries(liste.body.data.photos).map(([k, v]) => [k, v.length]))).toEqual({ avant: 1, pendant: 1, apres: 1 });
    });

    test('refus : phase absente/inconnue 422, légende trop longue 422, PDF / faux PNG / fichier absent refusés, rien d’écrit', async () => {
      const wo = await creer();
      const avant = await compter('work_photos', 'work_order_id = :id', { id: wo.id });
      expect((await envoyer(wo.id, 'apres-coup', await pngTest())).status).toBe(422);
      expect((await api().post(`${T}/${wo.id}/photos`).set(p.h).attach('fichier', await pngTest(), 'x.png')).status).toBe(422);
      expect((await envoyer(wo.id, 'avant', await pngTest(), 'x.png', { caption: 'x'.repeat(256) })).status).toBe(422);
      expect((await envoyer(wo.id, 'avant', await pngTest(), 'x.png', { captured_at: 'hier' })).status).toBe(422);
      expect((await envoyer(wo.id, 'avant', Buffer.from('%PDF-1.4\n%%EOF\n trailer'), 'x.pdf')).status).toBe(400);
      expect((await envoyer(wo.id, 'avant', Buffer.from('<svg onload=alert(1)></svg>'), 'x.png')).status).toBe(400);
      const sansFichier = await api().post(`${T}/${wo.id}/photos`).set(p.h).field('phase', 'avant');
      expect(sansFichier.status).toBeGreaterThanOrEqual(400);
      expect(sansFichier.status).toBeLessThan(500);
      expect(await compter('work_photos', 'work_order_id = :id', { id: wo.id })).toBe(avant);
    });

    test('retrait : 200, photo retirée, document supprimé LOGIQUEMENT, audit ; photo d’un autre chantier 404', async () => {
      const wo = await creer();
      const autreWo = await creer();
      const photo = (await envoyer(wo.id, 'pendant', await pngTest())).body.data.photo;
      expect((await api().delete(`${T}/${autreWo.id}/photos/${photo.id}`).set(p.h)).status).toBe(404);
      expect((await api().delete(`${T}/${wo.id}/photos/${photo.id}`).set(autre.h)).status).toBe(403);
      const res = await api().delete(`${T}/${wo.id}/photos/${photo.id}`).set(p.h);
      expect(res.status).toBe(200);
      expect(await compter('work_photos', 'id = :id', { id: photo.id })).toBe(0);
      expect(await compter('documents', 'id = :id AND deleted_at IS NOT NULL', { id: photo.document.id })).toBe(1);
      expect(await compter('audit_logs', "action = 'travaux.suppression' AND entity_id = :id", { id: wo.id })).toBe(1);
      expect((await api().delete(`${T}/${wo.id}/photos/pas-un-uuid`).set(p.h)).status).toBe(422);
    });

    test('travail terminé : photo « après » encore acceptée, retrait refusé ; travail annulé : ajout refusé', async () => {
      const termine = await placer('en_cours');
      const photo = (await envoyer(termine.id, 'avant', await pngTest())).body.data.photo;
      await statut(termine.id, { status: 'termine' });
      expect((await envoyer(termine.id, 'apres', await pngTest())).status).toBe(201);
      expect((await api().delete(`${T}/${termine.id}/photos/${photo.id}`).set(p.h)).body.error.code).toBe('PHOTOS_VERROUILLEES');

      const annule = await creer();
      await statut(annule.id, { status: 'annule', comment: 'Abandon' });
      const refus = await envoyer(annule.id, 'avant', await pngTest());
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('TRAVAUX_ANNULES');
    });
  });

  describe('§ 23 étape 7 — dépense du chantier', () => {
    test('rattachements repris du chantier, description par défaut, UNE sortie de caisse, audit', async () => {
      const wo = await creer({ apartment_id: apt.id, contractor_id: artisan.id, title: 'Porte d’entrée' });
      const res = await api().post(`${T}/${wo.id}/depenses`).set(p.h).send({ amount: 42000, method: 'especes', spent_on: '2026-09-22', building_id: crypto.randomUUID() });
      expect(res.status).toBe(201);
      const e = res.body.data.expense;
      expect(e).toMatchObject({
        building_id: bat.id, apartment_id: apt.id, contractor_id: artisan.id, work_order_id: wo.id, amount: 42000,
        description: `Travaux ${wo.reference} — Porte d’entrée`, category: { code: 'travaux' },
      });
      expect(await compter('cash_movements', "source_type = 'expense' AND source_id = :id AND category = 'travaux' AND direction = 'sortie'", { id: e.id })).toBe(1);
      // Catégorie et artisan explicites.
      const cat = (await api().get('/api/v1/categories-depenses').set(p.h)).body.data.categories.find((c) => c.code === 'entretien');
      const autreArtisan = (await api().post('/api/v1/artisans').set(p.h).send({ name: 'Second', trade: 'autre' })).body.data.contractor;
      const exp = await api().post(`${T}/${wo.id}/depenses`).set(p.h).send({ amount: 1000, method: 'wave', spent_on: '2026-09-22', category_id: cat.id, contractor_id: autreArtisan.id, description: 'Serrure' });
      expect(exp.body.data.expense).toMatchObject({ category: { code: 'entretien' }, contractor_id: autreArtisan.id, description: 'Serrure' });
    });

    test('validation 422, client_reference idempotente (200), travaux d’autrui 403, inconnus 404', async () => {
      const wo = await creer();
      for (const envoi of [{}, { amount: 0, method: 'especes', spent_on: '2026-09-22' }, { amount: 10, method: 'x', spent_on: '2026-09-22' }, { amount: 10, method: 'especes', spent_on: '2026-02-30' }]) {
        expect((await api().post(`${T}/${wo.id}/depenses`).set(p.h).send(envoi)).status).toBe(422);
      }
      const ref = `chantier-${crypto.randomBytes(5).toString('hex')}`;
      const envoi = { amount: 2000, method: 'especes', spent_on: '2026-09-22', client_reference: ref };
      const r1 = await api().post(`${T}/${wo.id}/depenses`).set(p.h).send(envoi);
      const r2 = await api().post(`${T}/${wo.id}/depenses`).set(p.h).send(envoi);
      expect([r1.status, r2.status]).toEqual([201, 200]);
      expect(r2.body.data.expense.id).toBe(r1.body.data.expense.id);
      expect(await compter('expenses', 'client_reference = :r', { r: ref })).toBe(1);
      expect((await api().post(`${T}/${wo.id}/depenses`).set(autre.h).send(envoi)).status).toBe(403);
      expect((await api().post(`${T}/${crypto.randomUUID()}/depenses`).set(p.h).send({ amount: 1, method: 'especes', spent_on: '2026-09-22' })).status).toBe(404);
    });
  });

  describe('E/F — liste : pagination, filtres, recherche, tri', () => {
    let proprio;
    let wos;
    let b1;
    let b2;
    let art;

    beforeAll(async () => {
      proprio = await nouveauProprietaire();
      b1 = await creerImmeuble(proprio);
      b2 = await creerImmeuble(proprio);
      const a1 = await creerAppartement(proprio, b1.id);
      art = (await api().post('/api/v1/artisans').set(proprio.h).send({ name: 'Moussa', trade: 'plombier' })).body.data.contractor;
      const defs = [
        { title: 'Fuite 100% réelle', building_id: b1.id, apartment_id: a1.id, category: 'plomberie', priority: 'haute', scheduled_for: '2026-10-03' },
        { title: 'Peinture_hall', building_id: b1.id, category: 'peinture', priority: 'basse', status: 'valide', contractor_id: art.id, scheduled_for: '2026-10-01' },
        { title: 'Serrure cave', building_id: b2.id, category: 'serrurerie', priority: 'urgente', status: 'a_valider', scheduled_for: '2026-10-02' },
      ];
      wos = [];
      for (const d of defs) wos.push((await api().post(T).set(proprio.h).send(d)).body.data.work_order);
      wos.push({ apartmentId: a1.id });
    });

    const liste = (query) => api().get(T).query(query).set(proprio.h);
    const ids = async (query) => (await liste(query)).body.data.items.map((w) => w.id).sort();

    test('filtres : statut, priorité, catégorie, immeuble, appartement, artisan, période ; recherche', async () => {
      expect(await ids({ status: 'valide' })).toEqual([wos[1].id]);
      expect(await ids({ priority: 'urgente' })).toEqual([wos[2].id]);
      expect(await ids({ category: 'plomberie' })).toEqual([wos[0].id]);
      expect(await ids({ building_id: b1.id })).toEqual([wos[0].id, wos[1].id].sort());
      expect(await ids({ apartment_id: wos[3].apartmentId })).toEqual([wos[0].id]);
      expect(await ids({ contractor_id: art.id })).toEqual([wos[1].id]);
      expect(await ids({ incident_id: crypto.randomUUID() })).toEqual([]);
      expect(await ids({ au: '2000-01-01' })).toEqual([]);
      expect(await ids({ q: '100%' })).toEqual([wos[0].id]);
      expect(await ids({ q: 'e_h' })).toEqual([wos[1].id]);
      expect(await ids({ q: 'e_c' })).toEqual([]); // « _ » littéral : « Serrure cave » ne correspond pas
      for (const terme of ["'; DELETE FROM work_orders; --", '%', '\\%', "' OR 1=1 --"]) {
        const res = await liste({ q: terme });
        expect(res.status).toBe(200);
        expect(res.body.data.items.every((w) => w.owner_id === proprio.ownerId)).toBe(true);
      }
      expect(await compter('work_orders', 'owner_id = :o', { o: proprio.ownerId })).toBe(3);
    });

    test('tri (numéro, date prévue, statut) ; pages ; plafond ; invalides 422', async () => {
      expect((await liste({ tri: 'number' })).body.data.items.map((w) => w.number)).toEqual([1, 2, 3]);
      expect((await liste({ tri: '-number' })).body.data.items.map((w) => w.number)).toEqual([3, 2, 1]);
      expect((await liste({ tri: 'scheduled_for' })).body.data.items.map((w) => w.scheduled_for)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
      const p2 = await liste({ tri: 'number', limit: 2, page: 2 });
      expect(p2.body.data.items.map((w) => w.number)).toEqual([3]);
      expect(p2.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect((await liste({ page: 50 })).body.data.items).toEqual([]);
      expect((await liste({ limit: 101 })).body.data.pagination.limit).toBe(100);
      for (const query of [{ page: 0 }, { limit: 0 }, { tri: 'title' }, { tri: 'owner_id' }, { priority: 'x' }, { category: 'x' }, { du: '2026-13-01' }, { q: 'x'.repeat(101) }]) {
        expect([query, (await liste(query)).status]).toEqual([query, 422]);
      }
    });
  });

  describe('C — autre propriétaire : 403, rien ne change', () => {
    test('chaque route /:id → 403 ; le travail, ses événements et ses photos sont inchangés', async () => {
      const wo = await creer({ status: 'valide' });
      const [avant] = await q('SELECT * FROM work_orders WHERE id = :id', { id: wo.id });
      const reponses = await Promise.all([
        api().get(`${T}/${wo.id}`).set(autre.h),
        api().patch(`${T}/${wo.id}`).set(autre.h).send({ title: 'Pirate' }),
        statut(wo.id, { status: 'annule', comment: 'Pirate' }, autre),
        api().get(`${T}/${wo.id}/photos`).set(autre.h),
        api().post(`${T}/${wo.id}/photos`).set(autre.h).field('phase', 'avant').attach('fichier', await pngTest(), 'p.png'),
        api().post(`${T}/${wo.id}/depenses`).set(autre.h).send({ amount: 1000, method: 'especes', spent_on: '2026-09-22' }),
      ]);
      for (const r of reponses) expect(r.status).toBe(403);
      expect((await q('SELECT * FROM work_orders WHERE id = :id', { id: wo.id }))[0]).toEqual(avant);
      expect(await evenements(wo.id)).toHaveLength(1);
      expect(await compter('work_photos', 'work_order_id = :id', { id: wo.id })).toBe(0);
      // Immeuble / appartement d'autrui à la création → 403.
      const batAutre = await creerImmeuble(autre);
      expect((await api().post(T).set(p.h).send({ title: 'Chez autrui', building_id: batAutre.id, category: 'autre' })).status).toBe(403);
      expect((await api().get(`${T}/${crypto.randomUUID()}`).set(p.h)).status).toBe(404);
      expect((await api().get(`${T}/${crypto.randomUUID()}/photos`).set(p.h)).status).toBe(404);
    });
  });
});
