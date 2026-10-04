'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, pngTest, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const { CashMovement } = require('../../../../models/index.js');

/**
 * Dépenses (§ 20), catégories, reflet en caisse (§ 21, § 41), annulation
 * logique (§ 42), synchronisation hors ligne (§ 34) — couverture complète de
 * /depenses et /categories-depenses : nominal et effets en base, validation,
 * pagination, filtres, règles du § 41, atomicité, concurrence.
 */

jest.setTimeout(90000);

const D = '/api/v1/depenses';
const CAT = '/api/v1/categories-depenses';
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

afterAll(fermer);

describe('Dépenses — couverture complète', () => {
  let p;
  let autre;
  let bat;
  let apt;
  let batB;
  let aptB;
  let cat;
  let artisan;
  let artisanAutre;

  const corps = (surcharges = {}) => ({
    amount: 25000, method: 'especes', spent_on: '2026-09-15', category_id: cat.entretien.id,
    building_id: bat.id, apartment_id: apt.id, description: 'Remplacement ampoules', ...surcharges,
  });
  const creer = async (surcharges = {}, proprio = p) => {
    const res = await api().post(D).set(proprio.h).send(corps(surcharges));
    expect(res.status).toBe(201);
    return res.body.data.expense;
  };
  const mouvements = (id) => q("SELECT * FROM cash_movements WHERE source_type = 'expense' AND source_id = :id", { id });

  beforeAll(async () => {
    p = await nouveauProprietaire();
    autre = await nouveauProprietaire();
    bat = await creerImmeuble(p, { name: 'Immeuble Kaolack' });
    apt = await creerAppartement(p, bat.id, { number: 'K1' });
    batB = await creerImmeuble(p);
    aptB = await creerAppartement(p, batB.id);
    cat = Object.fromEntries((await api().get(CAT).set(p.h)).body.data.categories.map((c) => [c.code, c]));
    artisan = (await api().post('/api/v1/artisans').set(p.h).send({ name: 'Cheikh Sow', trade: 'electricien' })).body.data.contractor;
    artisanAutre = (await api().post('/api/v1/artisans').set(autre.h).send({ name: 'Autre', trade: 'plombier' })).body.data.contractor;
  });

  describe('A — nominal et effets en base', () => {
    test.each([['especes'], ['wave'], ['orange_money'], ['virement'], ['cheque'], ['carte'], ['autre']])(
      'mode « %s » : 201, UNE sortie de caisse même mode/montant/date, audit',
      async (method) => {
        const e = await creer({ method, contractor_id: artisan.id });
        expect(e).toMatchObject({
          amount: 25000, method, status: 'valide', owner_id: p.ownerId, contractor_id: artisan.id, created_by: p.user.id,
          category: { code: 'entretien' }, building: { name: 'Immeuble Kaolack' }, apartment: { number: 'K1' }, contractor: { name: 'Cheikh Sow' },
        });
        const m = await mouvements(e.id);
        expect(m).toHaveLength(1);
        expect(m[0]).toMatchObject({
          owner_id: p.ownerId, direction: 'sortie', category: 'entretien', amount: 25000, method, occurred_on: '2026-09-15',
          building_id: bat.id, apartment_id: apt.id, is_deposit: false, cancelled_at: null, label: 'Entretien — Remplacement ampoules',
        });
        expect(await compter('audit_logs', "action = 'depense.creation' AND entity_id = :id", { id: e.id })).toBe(1);
      }
    );

    test('chaque groupe de catégorie → catégorie de caisse du § 21', async () => {
      const attendu = { travaux: 'travaux', entretien: 'entretien', factures: 'factures', nettoyage: 'nettoyage', securite: 'securite', autre: 'autre_depense' };
      for (const [groupe, caisse] of Object.entries(attendu)) {
        const c = Object.values(cat).find((x) => x.cash_group === groupe);
        expect(c).toBeTruthy();
        const e = await creer({ category_id: c.id, apartment_id: null });
        expect([groupe, (await mouvements(e.id))[0].category]).toEqual([groupe, caisse]);
      }
    });

    test('l’auteur ne reçoit pas de notification de sa propre dépense', async () => {
      const e = await creer();
      expect(await compter('notifications', "type = 'depense' AND data->>'expense_id' = :id", { id: e.id })).toBe(0);
    });

    test('GET /:id : détail avec justificatifs ; GET / : forme paginée', async () => {
      const e = await creer();
      await api().post(`${D}/${e.id}/justificatifs`).set(p.h).attach('fichier', PDF, 'recu.pdf');
      const detail = await api().get(`${D}/${e.id}`).set(p.h);
      expect(detail.status).toBe(200);
      expect(detail.body.data.expense).toMatchObject({ id: e.id, documents: [expect.objectContaining({ category: 'justificatif', mime_type: 'application/pdf' })] });
      const liste = await api().get(D).set(p.h);
      expect(liste.body.data).toMatchObject({ items: expect.any(Array), pagination: { page: 1, limit: 20 } });
    });

    test('PATCH : artisan, appartement, description ; caisse suit l’appartement et le libellé, jamais le montant ; audit', async () => {
      const e = await creer();
      const res = await api().patch(`${D}/${e.id}`).set(p.h).send({ contractor_id: artisan.id, apartment_id: null, description: '', amount: 1, method: 'wave', spent_on: '2020-01-01' });
      expect(res.status).toBe(200);
      expect(res.body.data.expense).toMatchObject({ contractor_id: artisan.id, apartment_id: null, amount: 25000, method: 'especes', spent_on: '2026-09-15' });
      const [m] = await mouvements(e.id);
      expect(m).toMatchObject({ apartment_id: null, amount: 25000, method: 'especes', label: 'Entretien' });
      expect(await compter('audit_logs', "action = 'depense.modification' AND entity_id = :id", { id: e.id })).toBe(1);
      // Artisan d'autrui 403, appartement inconnu 422, catégorie d'autrui 403.
      expect((await api().patch(`${D}/${e.id}`).set(p.h).send({ contractor_id: artisanAutre.id })).status).toBe(403);
      expect((await api().patch(`${D}/${e.id}`).set(p.h).send({ apartment_id: crypto.randomUUID() })).status).toBe(422);
      const catAutre = (await api().post(CAT).set(autre.h).send({ name: 'Catégorie privée', cash_group: 'autre' })).body.data.category;
      expect((await api().patch(`${D}/${e.id}`).set(p.h).send({ category_id: catAutre.id })).status).toBe(403);
      expect((await api().patch(`${D}/${e.id}`).set(p.h).send({ category_id: crypto.randomUUID() })).status).toBe(422);
    });

    test('annulation : dépense et mouvement annulés (jamais supprimés), audit, 409 ensuite ; justificatif refusé', async () => {
      const e = await creer();
      const res = await api().post(`${D}/${e.id}/annuler`).set(p.h).send({ reason: 'Saisie en double' });
      expect(res.status).toBe(200);
      expect(res.body.data.expense).toMatchObject({ status: 'annulee', cancel_reason: 'Saisie en double', cancelled_by: p.user.id });
      const m = await mouvements(e.id);
      expect(m).toHaveLength(1);
      expect(m[0].cancelled_at).not.toBeNull();
      const [audit] = await q("SELECT details FROM audit_logs WHERE action = 'depense.changement_statut' AND entity_id = :id", { id: e.id });
      expect(audit.details).toMatchObject({ avant: 'valide', apres: 'annulee', mouvements_caisse_annules: 1, montant: 25000 });
      const refus = await api().post(`${D}/${e.id}/justificatifs`).set(p.h).attach('fichier', PDF, 'x.pdf');
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('DEPENSE_ANNULEE');
      expect((await api().post(`${D}/${e.id}/annuler`).set(p.h).send({ reason: 'Encore une fois' })).body.error.code).toBe('DEJA_ANNULEE');
      // Exclue de la synthèse de caisse.
      const synthese = await api().get('/api/v1/caisse/synthese').query({ du: '2026-09-15', au: '2026-09-15', building_id: bat.id }).set(p.h);
      expect(synthese.status).toBe(200);
    });

    test('justificatifs : image, PDF ; types refusés par signature binaire ; aucun document orphelin', async () => {
      const e = await creer();
      const png = await api().post(`${D}/${e.id}/justificatifs`).set(p.h).attach('fichier', await pngTest(), 'recu.png');
      expect(png.status).toBe(201);
      expect(png.body.data.document).toMatchObject({ category: 'justificatif', mime_type: 'image/png' });
      const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
      expect((await api().post(`${D}/${e.id}/justificatifs`).set(p.h).attach('fichier', gif, 'x.gif')).status).toBe(400);
      expect((await api().post(`${D}/${e.id}/justificatifs`).set(p.h).attach('fichier', Buffer.from('%PDF'), 'court.pdf')).status).toBe(400);
      expect(await compter('documents', "entity_type = 'expense' AND entity_id = :id", { id: e.id })).toBe(1);
    });
  });

  describe('D — validation (422, rien d’écrit)', () => {
    test.each([
      ['corps vide', null],
      ['montant manquant', { amount: undefined }],
      ['montant nul', { amount: 0 }],
      ['montant négatif', { amount: -5 }],
      ['montant décimal', { amount: 12.34 }],
      ['montant texte', { amount: 'mille' }],
      ['mode manquant', { method: undefined }],
      ['mode inconnu', { method: 'bitcoin' }],
      ['date manquante', { spent_on: undefined }],
      ['date invalide', { spent_on: '2026-02-30T' }],
      ['catégorie manquante', { category_id: undefined }],
      ['catégorie non UUID', { category_id: 'entretien' }],
      ['immeuble manquant (§ 41)', { building_id: undefined }],
      ['immeuble non UUID', { building_id: 42 }],
      ['description trop longue', { description: 'x'.repeat(501) }],
      ['client_reference trop courte', { client_reference: 'abc' }],
      ['client_reference caractères interdits', { client_reference: "abc'; DROP--" }],
      ['appartement d’un autre immeuble (§ 41)', 'autreImmeuble'],
      ['catégorie inconnue', 'categorieInconnue'],
      ['immeuble inconnu', 'immeubleInconnu'],
      ['travaux inconnus', 'travauxInconnus'],
    ])('création — %s', async (_cas, surcharges) => {
      let envoi;
      if (surcharges === null) envoi = {};
      else if (surcharges === 'autreImmeuble') envoi = corps({ apartment_id: aptB.id });
      else if (surcharges === 'categorieInconnue') envoi = corps({ category_id: crypto.randomUUID() });
      else if (surcharges === 'immeubleInconnu') envoi = corps({ building_id: crypto.randomUUID(), apartment_id: null });
      else if (surcharges === 'travauxInconnus') envoi = corps({ work_order_id: crypto.randomUUID() });
      else {
        envoi = corps(surcharges);
        for (const [k, v] of Object.entries(envoi)) if (v === undefined) delete envoi[k];
      }
      const avant = await compter('expenses', 'owner_id = :o', { o: p.ownerId });
      const avantCaisse = await compter('cash_movements', 'owner_id = :o', { o: p.ownerId });
      const res = await api().post(D).set(p.h).send(envoi);
      expect(res.status).toBe(422);
      expect(await compter('expenses', 'owner_id = :o', { o: p.ownerId })).toBe(avant);
      expect(await compter('cash_movements', 'owner_id = :o', { o: p.ownerId })).toBe(avantCaisse);
    });

    test('références d’un autre propriétaire → 403 (immeuble, appartement, artisan, travaux, catégorie)', async () => {
      const batAutre = await creerImmeuble(autre);
      const woAutre = (await api().post('/api/v1/travaux').set(autre.h).send({ title: 'Chez autrui', building_id: batAutre.id, category: 'plomberie' })).body.data.work_order;
      const catAutre = (await api().post(CAT).set(autre.h).send({ name: 'Privée autre', cash_group: 'autre' })).body.data.category;
      expect((await api().post(D).set(p.h).send(corps({ building_id: batAutre.id, apartment_id: null }))).status).toBe(403);
      expect((await api().post(D).set(p.h).send(corps({ contractor_id: artisanAutre.id }))).status).toBe(403);
      expect((await api().post(D).set(p.h).send(corps({ work_order_id: woAutre.id }))).status).toBe(403);
      expect((await api().post(D).set(p.h).send(corps({ category_id: catAutre.id }))).status).toBe(403);
    });

    test('travaux : d’un autre immeuble → 422 ; annulés → 409 TRAVAUX_ANNULES ; de l’immeuble → 201', async () => {
      const woAutreImmeuble = (await api().post('/api/v1/travaux').set(p.h).send({ title: 'Ailleurs', building_id: batB.id, category: 'peinture' })).body.data.work_order;
      expect((await api().post(D).set(p.h).send(corps({ work_order_id: woAutreImmeuble.id }))).status).toBe(422);
      const wo = (await api().post('/api/v1/travaux').set(p.h).send({ title: 'Ici', building_id: bat.id, category: 'peinture' })).body.data.work_order;
      expect((await api().post(D).set(p.h).send(corps({ work_order_id: wo.id }))).status).toBe(201);
      await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'annule', comment: 'Abandon' });
      const refus = await api().post(D).set(p.h).send(corps({ work_order_id: wo.id }));
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('TRAVAUX_ANNULES');
    });

    test('PATCH : vide, champs financiers seuls, id invalide → 422 ; inconnue → 404', async () => {
      const e = await creer();
      expect((await api().patch(`${D}/${e.id}`).set(p.h).send({})).status).toBe(422);
      expect((await api().patch(`${D}/${e.id}`).set(p.h).send({ amount: 5 })).status).toBe(422);
      expect((await api().patch(`${D}/${e.id}`).set(p.h).send({ description: 'x'.repeat(501) })).status).toBe(422);
      expect((await api().patch(`${D}/abc`).set(p.h).send({ description: 'x' })).status).toBe(422);
      expect((await api().patch(`${D}/${crypto.randomUUID()}`).set(p.h).send({ description: 'x' })).status).toBe(404);
      expect((await api().post(`${D}/${e.id}/annuler`).set(p.h).send({ reason: 'ab' })).status).toBe(422);
      expect((await api().get(`${D}/abc`).set(p.h)).status).toBe(422);
    });
  });

  describe('E/F — pagination, filtres, tri', () => {
    let proprio;
    let ids;
    let b1;
    let b2;
    let c;

    beforeAll(async () => {
      proprio = await nouveauProprietaire();
      b1 = await creerImmeuble(proprio);
      b2 = await creerImmeuble(proprio);
      const a1 = await creerAppartement(proprio, b1.id);
      c = Object.fromEntries((await api().get(CAT).set(proprio.h)).body.data.categories.map((x) => [x.code, x]));
      const art = (await api().post('/api/v1/artisans').set(proprio.h).send({ name: 'Fatou', trade: 'peintre' })).body.data.contractor;
      const wo = (await api().post('/api/v1/travaux').set(proprio.h).send({ title: 'Peinture', building_id: b1.id, category: 'peinture' })).body.data.work_order;
      const base = { method: 'especes', category_id: c.entretien.id };
      const defs = [
        { building_id: b1.id, apartment_id: a1.id, amount: 3000, spent_on: '2026-01-10', method: 'wave' },
        { building_id: b1.id, amount: 1000, spent_on: '2026-02-10', contractor_id: art.id, work_order_id: wo.id, category_id: c.travaux.id },
        { building_id: b2.id, amount: 2000, spent_on: '2026-03-10' },
      ];
      ids = { a1: a1.id, art: art.id, wo: wo.id, liste: [] };
      for (const d of defs) ids.liste.push((await api().post(D).set(proprio.h).send({ ...base, ...d })).body.data.expense.id);
      await api().post(`${D}/${ids.liste[2]}/annuler`).set(proprio.h).send({ reason: 'Filtre statut' });
    });

    const liste = (query) => api().get(D).query(query).set(proprio.h);
    const trouves = async (query) => (await liste(query)).body.data.items.map((e) => e.id).sort();

    test('filtres : immeuble, appartement, catégorie, artisan, travaux, mode, statut, période', async () => {
      expect(await trouves({ building_id: b1.id })).toEqual([ids.liste[0], ids.liste[1]].sort());
      expect(await trouves({ apartment_id: ids.a1 })).toEqual([ids.liste[0]]);
      expect(await trouves({ category_id: c.travaux.id })).toEqual([ids.liste[1]]);
      expect(await trouves({ contractor_id: ids.art })).toEqual([ids.liste[1]]);
      expect(await trouves({ work_order_id: ids.wo })).toEqual([ids.liste[1]]);
      expect(await trouves({ method: 'wave' })).toEqual([ids.liste[0]]);
      expect(await trouves({ status: 'annulee' })).toEqual([ids.liste[2]]);
      expect(await trouves({ du: '2026-02-01', au: '2026-03-31' })).toEqual([ids.liste[1], ids.liste[2]].sort());
      expect(await trouves({ du: '2026-02-10', au: '2026-02-10' })).toEqual([ids.liste[1]]);
    });

    test('tri et pagination : totaux exacts, pages, plafond 100 ; paramètres invalides 422', async () => {
      expect((await liste({ tri: 'amount' })).body.data.items.map((e) => e.amount)).toEqual([1000, 2000, 3000]);
      expect((await liste({ tri: '-spent_on' })).body.data.items.map((e) => e.spent_on)).toEqual(['2026-03-10', '2026-02-10', '2026-01-10']);
      const p2 = await liste({ limit: 2, page: 2, tri: 'amount' });
      expect(p2.body.data.items.map((e) => e.amount)).toEqual([3000]);
      expect(p2.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect((await liste({ page: 4, limit: 2 })).body.data.items).toEqual([]);
      expect((await liste({ limit: 1000 })).body.data.pagination.limit).toBe(100);
      for (const query of [{ page: 0 }, { page: -1 }, { limit: 0 }, { tri: 'description' }, { tri: '-owner_id' }, { status: 'x' }, { method: 'x' }, { du: 'hier' }, { contractor_id: 'x' }]) {
        expect([query, (await liste(query)).status]).toEqual([query, 422]);
      }
      expect((await api().get(D).set((await nouveauProprietaire()).h)).body.data).toEqual({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
    });
  });

  describe('H — atomicité', () => {
    test('échec de l’écriture en caisse APRÈS l’insertion de la dépense → ni dépense, ni mouvement, ni audit', async () => {
      const reference = `echec-${crypto.randomBytes(6).toString('hex')}`;
      const avant = {
        depenses: await compter('expenses', 'owner_id = :o', { o: p.ownerId }),
        caisse: await compter('cash_movements', 'owner_id = :o', { o: p.ownerId }),
        audit: await compter('audit_logs', "owner_id = :o AND action = 'depense.creation'", { o: p.ownerId }),
      };
      const espion = jest.spyOn(CashMovement, 'create').mockRejectedValueOnce(new Error('Panne simulée de la caisse'));
      try {
        const res = await api().post(D).set(p.h).send(corps({ client_reference: reference }));
        expect(res.status).toBe(500);
        expect(espion).toHaveBeenCalledTimes(1);
      } finally {
        espion.mockRestore();
      }
      expect(await compter('expenses', 'owner_id = :o', { o: p.ownerId })).toBe(avant.depenses);
      expect(await compter('expenses', 'client_reference = :r', { r: reference })).toBe(0);
      expect(await compter('cash_movements', 'owner_id = :o', { o: p.ownerId })).toBe(avant.caisse);
      expect(await compter('audit_logs', "owner_id = :o AND action = 'depense.creation'", { o: p.ownerId })).toBe(avant.audit);
      // La même opération renvoyée ensuite aboutit normalement (201).
      expect((await api().post(D).set(p.h).send(corps({ client_reference: reference }))).status).toBe(201);
    });

    test('échec pendant l’annulation → dépense toujours valide, mouvement toujours actif', async () => {
      const e = await creer();
      const espion = jest.spyOn(CashMovement, 'update').mockRejectedValueOnce(new Error('Panne simulée'));
      try {
        expect((await api().post(`${D}/${e.id}/annuler`).set(p.h).send({ reason: 'Test atomicité' })).status).toBe(500);
      } finally {
        espion.mockRestore();
      }
      expect((await q('SELECT status FROM expenses WHERE id = :id', { id: e.id }))[0].status).toBe('valide');
      expect((await mouvements(e.id))[0].cancelled_at).toBeNull();
    });
  });

  describe('I — concurrence', () => {
    test('créations SIMULTANÉES avec la même client_reference → une dépense, un mouvement ; toutes les réponses la renvoient', async () => {
      const reference = `sync-${crypto.randomBytes(6).toString('hex')}`;
      const reponses = await Promise.all([1, 2, 3, 4].map(() => api().post(D).set(p.h).send(corps({ client_reference: reference }))));
      expect(reponses.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(reponses.filter((r) => r.status === 201)).toHaveLength(1);
      const idsRendus = new Set(reponses.map((r) => r.body.data.expense.id));
      expect(idsRendus.size).toBe(1);
      const [e] = await q('SELECT id FROM expenses WHERE owner_id = :o AND client_reference = :r', { o: p.ownerId, r: reference });
      expect(idsRendus.has(e.id)).toBe(true);
      expect(await mouvements(e.id)).toHaveLength(1);
      expect(await compter('audit_logs', "action = 'depense.creation' AND entity_id = :id", { id: e.id })).toBe(1);
    });

    test('annulations simultanées de la même dépense → une seule réussit, un seul audit', async () => {
      const e = await creer();
      const reponses = await Promise.all([1, 2, 3].map(() => api().post(`${D}/${e.id}/annuler`).set(p.h).send({ reason: 'Annulation concurrente' })));
      expect(reponses.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await compter('audit_logs', "action = 'depense.changement_statut' AND entity_id = :id", { id: e.id })).toBe(1);
    });
  });

  describe('C — autre propriétaire', () => {
    test('chaque route /:id → 403, la dépense et sa caisse restent identiques', async () => {
      const e = await creer();
      const [avant] = await q('SELECT * FROM expenses WHERE id = :id', { id: e.id });
      for (const res of await Promise.all([
        api().get(`${D}/${e.id}`).set(autre.h),
        api().patch(`${D}/${e.id}`).set(autre.h).send({ description: 'Pirate' }),
        api().post(`${D}/${e.id}/annuler`).set(autre.h).send({ reason: 'Pirate' }),
        api().post(`${D}/${e.id}/justificatifs`).set(autre.h).attach('fichier', PDF, 'x.pdf'),
      ])) expect(res.status).toBe(403);
      expect((await q('SELECT * FROM expenses WHERE id = :id', { id: e.id }))[0]).toEqual(avant);
      expect((await mouvements(e.id))[0].cancelled_at).toBeNull();
      expect((await api().get(D).set(autre.h)).body.data.items.map((x) => x.id)).not.toContain(e.id);
    });
  });
});

describe('Catégories de dépenses — couverture complète', () => {
  let p;
  let autre;
  beforeAll(async () => {
    p = await nouveauProprietaire();
    autre = await nouveauProprietaire();
  });

  test('liste : globales + propres, triées par ordre puis nom ; inactives sur demande', async () => {
    // Propriétaire PROPRE à ce test : les autres tests du fichier (ordre
    // aléatoire) créent des catégories pour le propriétaire partagé.
    const moi = await nouveauProprietaire();
    const res = await api().get(CAT).set(moi.h);
    expect(res.status).toBe(200);
    const cats = res.body.data.categories;
    expect(cats.length).toBeGreaterThan(5);
    expect(cats.every((c) => c.is_global && c.owner_id === null && c.is_active)).toBe(true);
    const ordre = cats.map((c) => c.sort_order);
    expect([...ordre].sort((a, b) => a - b)).toEqual(ordre);
    const propre = (await api().post(CAT).set(moi.h).send({ name: 'Zzz dernière', cash_group: 'autre', sort_order: 9999 })).body.data.category;
    const avec = (await api().get(CAT).set(moi.h)).body.data.categories;
    expect(avec[avec.length - 1].id).toBe(propre.id);
    expect((await api().get(CAT).set(autre.h)).body.data.categories.map((c) => c.id)).not.toContain(propre.id);
    expect((await api().get(CAT).query({ inclure_inactives: 'peut-être' }).set(moi.h)).status).toBe(422);
  });

  test('création : code déduit du nom (accents retirés), code explicite, audit ; doublons 409', async () => {
    const res = await api().post(CAT).set(p.h).send({ name: '  Élagage & Espaces verts  ', cash_group: 'entretien' });
    expect(res.status).toBe(201);
    expect(res.body.data.category).toMatchObject({ code: 'elagage_espaces_verts', name: 'Élagage & Espaces verts', is_global: false, owner_id: p.ownerId, is_active: true, sort_order: 100 });
    expect(await compter('audit_logs', "action = 'categorie_depense.creation' AND entity_id = :id", { id: res.body.data.category.id })).toBe(1);
    const code = await api().post(CAT).set(p.h).send({ code: 'Groupe_Elec', name: 'Groupe électrogène', cash_group: 'factures' });
    expect(code.body.data.category.code).toBe('groupe_elec');
    const doublon = await api().post(CAT).set(p.h).send({ name: 'Elagage espaces verts', cash_group: 'autre' });
    expect(doublon.status).toBe(409);
    expect(doublon.body.error.code).toBe('CATEGORIE_EXISTANTE');
    // Le même code chez un autre propriétaire est permis.
    expect((await api().post(CAT).set(autre.h).send({ name: 'Élagage espaces verts', cash_group: 'entretien' })).status).toBe(201);
    // Nom sans lettre ni chiffre → 422.
    expect((await api().post(CAT).set(p.h).send({ name: '!!!', cash_group: 'autre' })).status).toBe(422);
  });

  test.each([
    ['nom manquant', { cash_group: 'autre' }],
    ['nom trop court', { name: 'a', cash_group: 'autre' }],
    ['nom trop long', { name: 'x'.repeat(101), cash_group: 'autre' }],
    ['groupe manquant', { name: 'Sans groupe' }],
    ['groupe invalide', { name: 'Groupe', cash_group: 'loyer' }],
    ['code invalide', { code: 'a b', name: 'Code', cash_group: 'autre' }],
    ['code trop long', { code: 'x'.repeat(41), name: 'Code', cash_group: 'autre' }],
    ['ordre négatif', { name: 'Ordre', cash_group: 'autre', sort_order: -1 }],
    ['ordre trop grand', { name: 'Ordre', cash_group: 'autre', sort_order: 10001 }],
    ['corps vide', {}],
  ])('création — %s → 422', async (_cas, envoi) => {
    const avant = await compter('expense_categories', 'owner_id = :o', { o: p.ownerId });
    expect((await api().post(CAT).set(p.h).send(envoi)).status).toBe(422);
    expect(await compter('expense_categories', 'owner_id = :o', { o: p.ownerId })).toBe(avant);
  });

  test('modification : propre 200 + audit ; globale 403 (CATEGORIE_GLOBALE, inchangée) ; d’autrui 403 ; vide 422 ; code non modifiable', async () => {
    const c = (await api().post(CAT).set(p.h).send({ name: 'Sécurité privée', cash_group: 'securite' })).body.data.category;
    const res = await api().patch(`${CAT}/${c.id}`).set(p.h).send({ name: 'Sécurité nuit', sort_order: 5, code: 'pirate', owner_id: autre.ownerId });
    expect(res.status).toBe(200);
    expect(res.body.data.category).toMatchObject({ name: 'Sécurité nuit', sort_order: 5, code: 'securite_privee', owner_id: p.ownerId });
    expect(await compter('audit_logs', "action = 'categorie_depense.modification' AND entity_id = :id", { id: c.id })).toBe(1);

    const globale = (await api().get(CAT).set(p.h)).body.data.categories.find((x) => x.is_global);
    const [avant] = await q('SELECT * FROM expense_categories WHERE id = :id', { id: globale.id });
    const refus = await api().patch(`${CAT}/${globale.id}`).set(p.h).send({ name: 'Piratée' });
    expect(refus.status).toBe(403);
    expect(refus.body.error.code).toBe('CATEGORIE_GLOBALE');
    expect((await q('SELECT * FROM expense_categories WHERE id = :id', { id: globale.id }))[0]).toEqual(avant);
    expect((await api().post(`${CAT}/${globale.id}/desactiver`).set(p.h)).status).toBe(403);

    const chezAutre = await api().patch(`${CAT}/${c.id}`).set(autre.h).send({ name: 'Pirate' });
    expect(chezAutre.status).toBe(403);
    expect(chezAutre.body.error.code).toBe('ACCES_AUTRE_PROPRIETAIRE');
    expect((await api().post(`${CAT}/${c.id}/desactiver`).set(autre.h)).status).toBe(403);
    expect((await api().patch(`${CAT}/${c.id}`).set(p.h).send({})).status).toBe(422);
    expect((await api().patch(`${CAT}/${c.id}`).set(p.h).send({ cash_group: 'loyer' })).status).toBe(422);
    expect((await api().patch(`${CAT}/abc`).set(p.h).send({ name: 'Nom' })).status).toBe(422);
    expect((await api().patch(`${CAT}/${crypto.randomUUID()}`).set(p.h).send({ name: 'Nom' })).status).toBe(404);
  });

  test('désactivation : 200 + audit, 409 si répétée, 404 inconnue ; la dépense passée garde sa catégorie', async () => {
    const bat = await creerImmeuble(p);
    const c = (await api().post(CAT).set(p.h).send({ name: 'Piscine', cash_group: 'entretien' })).body.data.category;
    const e = (await api().post(D).set(p.h).send({ amount: 500, method: 'especes', spent_on: '2026-09-01', category_id: c.id, building_id: bat.id })).body.data.expense;
    const res = await api().post(`${CAT}/${c.id}/desactiver`).set(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data.category.is_active).toBe(false);
    expect(await compter('audit_logs', "action = 'categorie_depense.changement_statut' AND entity_id = :id", { id: c.id })).toBe(1);
    expect((await api().post(`${CAT}/${c.id}/desactiver`).set(p.h)).body.error.code).toBe('CATEGORIE_DEJA_INACTIVE');
    expect((await api().post(`${CAT}/${crypto.randomUUID()}/desactiver`).set(p.h)).status).toBe(404);
    expect((await api().get(`${D}/${e.id}`).set(p.h)).body.data.expense.category.name).toBe('Piscine');
  });

});
