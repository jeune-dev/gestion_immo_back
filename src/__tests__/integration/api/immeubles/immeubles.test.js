'use strict';

const crypto = require('crypto');
const {
  api, nouveauProprietaire, superAdmin, proprietaireEtLocataire, creerImmeuble, creerAppartement,
  expirerAbonnement, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 7 Immeubles — CRUD, validation, pagination, recherche, tri, contrôle
 * d'accès (§ 32, § 43), limites de formule et lecture seule (§ 31).
 */

const URL = '/api/v1/immeubles';
const INCONNU = '00000000-0000-4000-8000-000000000000';
const nomUnique = (prefixe = 'Residence') => `${prefixe} ${crypto.randomBytes(4).toString('hex')}`;

afterAll(fermer);

describe('Création et lecture', () => {
  test('création : 201, forme de la réponse, owner_id de l’appelant, audit', async () => {
    const p = await nouveauProprietaire();
    const corps = { name: nomUnique(), address: 'Route des Almadies', district: 'Ngor', city: 'Dakar', floors_count: 5, declared_apartments_count: 12, description: 'Vue mer' };
    const res = await api().post(URL).set(p.h).send(corps);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Immeuble créé' });
    expect(res.body.data.building).toMatchObject({ ...corps, id: expect.any(String), owner_id: p.ownerId });
    const [[ligne]] = await sequelize.query('SELECT owner_id, name, floors_count FROM buildings WHERE id = :id', { replacements: { id: res.body.data.building.id } });
    expect(ligne).toEqual({ owner_id: p.ownerId, name: corps.name, floors_count: 5 });
    const [[audit]] = await sequelize.query("SELECT user_id, owner_id, actor_role, details FROM audit_logs WHERE action = 'immeuble.creation' AND entity_id = :id", { replacements: { id: res.body.data.building.id } });
    expect(audit).toMatchObject({ user_id: p.user.id, owner_id: p.ownerId, details: { name: corps.name } });
  });

  test('élévation : owner_id, id, deleted_at envoyés sont ignorés', async () => {
    const victime = await nouveauProprietaire();
    const p = await nouveauProprietaire();
    const res = await api().post(URL).set(p.h).send({ name: nomUnique(), address: 'Plateau', city: 'Dakar', owner_id: victime.ownerId, id: INCONNU, deleted_at: '2020-01-01' });
    expect(res.status).toBe(201);
    expect(res.body.data.building.owner_id).toBe(p.ownerId);
    expect(res.body.data.building.id).not.toBe(INCONNU);
    expect(await compter('buildings', 'owner_id = :o', { o: victime.ownerId })).toBe(0);
  });

  test('détail : statistiques d’occupation et documents', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    await creerAppartement(p, b.id);
    await creerAppartement(p, b.id);
    const res = await api().get(`${URL}/${b.id}`).set(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data.building).toMatchObject({ id: b.id, apartments_count: 2, occupied_count: 0, available_count: 2, documents: [] });
  });

  test('détail : 404 inconnu, 422 identifiant non UUID', async () => {
    const p = await nouveauProprietaire();
    expect((await api().get(`${URL}/${INCONNU}`).set(p.h)).status).toBe(404);
    expect((await api().get(`${URL}/123`).set(p.h)).status).toBe(422);
    expect((await api().get(`${URL}/' OR 1=1 --`).set(p.h)).status).toBe(422);
  });
});

describe('Validation', () => {
  test.each([
    ['nom manquant', { address: 'A', city: 'Dakar' }],
    ['adresse manquante', { name: 'R', city: 'Dakar' }],
    ['ville manquante', { name: 'R', address: 'A' }],
    ['nom vide', { name: '  ', address: 'A', city: 'Dakar' }],
    ['nom de 151 caractères', { name: 'n'.repeat(151), address: 'A', city: 'Dakar' }],
    ['adresse de 256 caractères', { name: 'R', address: 'a'.repeat(256), city: 'Dakar' }],
    ['quartier de 101 caractères', { name: 'R', address: 'A', city: 'Dakar', district: 'q'.repeat(101) }],
    ['description de 5001 caractères', { name: 'R', address: 'A', city: 'Dakar', description: 'd'.repeat(5001) }],
    ['étages négatifs', { name: 'R', address: 'A', city: 'Dakar', floors_count: -1 }],
    ['301 étages', { name: 'R', address: 'A', city: 'Dakar', floors_count: 301 }],
    ['étages non numériques', { name: 'R', address: 'A', city: 'Dakar', floors_count: 'abc' }],
    ['étages décimaux', { name: 'R', address: 'A', city: 'Dakar', floors_count: 2.5 }],
    ['appartements déclarés négatifs', { name: 'R', address: 'A', city: 'Dakar', declared_apartments_count: -3 }],
    ['nom non textuel', { name: { $gt: '' }, address: 'A', city: 'Dakar' }],
    ['corps vide', {}],
  ])('création 422 : %s — rien n’est écrit', async (_l, corps) => {
    const p = await nouveauProprietaire();
    const res = await api().post(URL).set(p.h).send(corps);
    expect(res.status).toBe(422);
    expect(await compter('buildings', 'owner_id = :o', { o: p.ownerId })).toBe(0);
  });

  test('doublon de nom chez le même propriétaire (casse différente) : 409 ; même nom chez un autre : permis', async () => {
    const p = await nouveauProprietaire();
    const nom = nomUnique();
    await creerImmeuble(p, { name: nom });
    const doublon = await api().post(URL).set(p.h).send({ name: nom.toUpperCase(), address: 'A', city: 'Dakar' });
    expect(doublon.status).toBe(409);
    const autre = await nouveauProprietaire();
    expect((await api().post(URL).set(autre.h).send({ name: nom, address: 'A', city: 'Dakar' })).status).toBe(201);
  });

  test('modification : corps vide 422, nom trop long 422, renommage en doublon 409', async () => {
    const p = await nouveauProprietaire();
    const a = await creerImmeuble(p);
    const b = await creerImmeuble(p);
    expect((await api().patch(`${URL}/${a.id}`).set(p.h).send({})).status).toBe(422);
    expect((await api().patch(`${URL}/${a.id}`).set(p.h).send({ name: 'x'.repeat(151) })).status).toBe(422);
    expect((await api().patch(`${URL}/${a.id}`).set(p.h).send({ name: b.name })).status).toBe(409);
  });
});

describe('Modification et suppression', () => {
  test('modification : champs changés, owner_id ignoré, audit avec différence', async () => {
    const p = await nouveauProprietaire();
    const autre = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    const res = await api().patch(`${URL}/${b.id}`).set(p.h).send({ city: 'Saint-Louis', floors_count: 2, owner_id: autre.ownerId });
    expect(res.status).toBe(200);
    expect(res.body.data.building).toMatchObject({ city: 'Saint-Louis', floors_count: 2, owner_id: p.ownerId });
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'immeuble.modification' AND entity_id = :id", { replacements: { id: b.id } });
    expect(audit.details).toEqual({ city: { avant: 'Dakar', apres: 'Saint-Louis' }, floors_count: { avant: 4, apres: 2 } });
  });

  test('suppression : logique, audit, le nom redevient disponible ; 404 ensuite', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    const res = await api().delete(`${URL}/${b.id}`).set(p.h);
    expect(res.status).toBe(200);
    expect(await compter('buildings', 'id = :id AND deleted_at IS NOT NULL', { id: b.id })).toBe(1);
    expect(await compter('audit_logs', "action = 'immeuble.suppression' AND entity_id = :id", { id: b.id })).toBe(1);
    expect((await api().get(`${URL}/${b.id}`).set(p.h)).status).toBe(404);
    expect((await api().delete(`${URL}/${b.id}`).set(p.h)).status).toBe(404);
    expect((await api().post(URL).set(p.h).send({ name: b.name, address: 'A', city: 'Dakar' })).status).toBe(201);
  });

  test('suppression refusée si l’immeuble contient des appartements (409 IMMEUBLE_NON_VIDE)', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    await creerAppartement(p, b.id);
    const res = await api().delete(`${URL}/${b.id}`).set(p.h);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IMMEUBLE_NON_VIDE');
    expect(await compter('buildings', 'id = :id AND deleted_at IS NULL', { id: b.id })).toBe(1);
  });
});

describe('Contrôle d’accès', () => {
  test('immeuble d’un autre propriétaire : GET, PATCH, DELETE → 403, base inchangée', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const immeuble = await creerImmeuble(a);
    for (const [methode, corps] of [['get'], ['patch', { name: 'Piraté' }], ['delete']]) {
      const res = await api()[methode](`${URL}/${immeuble.id}`).set(b.h).send(corps);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCES_AUTRE_PROPRIETAIRE');
    }
    const [[ligne]] = await sequelize.query('SELECT name, deleted_at FROM buildings WHERE id = :id', { replacements: { id: immeuble.id } });
    expect(ligne).toEqual({ name: immeuble.name, deleted_at: null });
    const liste = await api().get(URL).set(b.h);
    expect(liste.body.data.items).toEqual([]);
  });

  test('locataire, super admin, anonyme : refusés', async () => {
    const { locataire, building } = await proprietaireEtLocataire();
    const admin = await superAdmin();
    for (const h of [locataire.h, admin.h]) {
      expect((await api().get(URL).set(h)).status).toBe(403);
      expect((await api().get(`${URL}/${building.id}`).set(h)).status).toBe(403);
      expect((await api().post(URL).set(h).send({ name: 'R', address: 'A', city: 'Dakar' })).status).toBe(403);
    }
    expect((await api().get(URL)).status).toBe(401);
  });

  test('espace suspendu par l’administrateur : 403 ESPACE_SUSPENDU (lecture comprise), réactivé : accès rétabli', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE owners SET status = 'suspendu' WHERE id = :o", { replacements: { o: p.ownerId } });
    const res = await api().get(URL).set(p.h);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ESPACE_SUSPENDU');
    await sequelize.query("UPDATE owners SET status = 'actif' WHERE id = :o", { replacements: { o: p.ownerId } });
    expect((await api().get(URL).set(p.h)).status).toBe(200);
  });

  test('abonnement échu : lecture permise, écritures 402 ABONNEMENT_REQUIS', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    await expirerAbonnement(p.ownerId);
    expect((await api().get(URL).set(p.h)).status).toBe(200);
    expect((await api().get(`${URL}/${b.id}`).set(p.h)).status).toBe(200);
    for (const [methode, url, corps] of [['post', URL, { name: 'R', address: 'A', city: 'Dakar' }], ['patch', `${URL}/${b.id}`, { name: 'X' }], ['delete', `${URL}/${b.id}`]]) {
      const res = await api()[methode](url).set(p.h).send(corps);
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('ABONNEMENT_REQUIS');
    }
    expect(await compter('buildings', 'owner_id = :o AND deleted_at IS NULL', { o: p.ownerId })).toBe(1);
  });
});

describe('Liste : pagination, recherche, filtres, tri', () => {
  let p;
  // 5 immeubles : le maximum de la formule d'essai (BUSINESS).
  const noms = ['Alpha', 'Écho 100%', 'Foxtrot_1', "L'Oasis", 'Back\\slash'];
  beforeAll(async () => {
    p = await nouveauProprietaire();
    for (const [i, nom] of noms.entries()) await creerImmeuble(p, { name: nom, city: i % 2 ? 'Thiès' : 'Dakar' });
  });

  test('liste vide pour un nouveau propriétaire', async () => {
    const vide = await nouveauProprietaire();
    const res = await api().get(URL).set(vide.h);
    expect(res.body.data).toEqual({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
  });

  test('pages 1, 2, au-delà : totaux exacts', async () => {
    const p1 = await api().get(URL).query({ limit: 2, page: 1 }).set(p.h);
    expect(p1.body.data.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
    expect(p1.body.data.items).toHaveLength(2);
    const p3 = await api().get(URL).query({ limit: 2, page: 3 }).set(p.h);
    expect(p3.body.data.items).toHaveLength(1);
    const ids = new Set([...p1.body.data.items, ...(await api().get(URL).query({ limit: 2, page: 2 }).set(p.h)).body.data.items, ...p3.body.data.items].map((b) => b.id));
    expect(ids.size).toBe(5);
    const loin = await api().get(URL).query({ limit: 2, page: 50 }).set(p.h);
    expect(loin.status).toBe(200);
    expect(loin.body.data.items).toEqual([]);
    expect(loin.body.data.pagination).toEqual({ page: 50, limit: 2, total: 5, totalPages: 3 });
  });

  test.each([
    ['page 0', { page: 0 }], ['page -1', { page: -1 }], ['limit 0', { limit: 0 }], ['limit abc', { limit: 'abc' }],
    ['page 1.5', { page: 1.5 }], ['tri inconnu', { tri: 'password_hash' }], ['tri injecté', { tri: 'name; DROP TABLE buildings' }],
    ['recherche de 101 caractères', { q: 'q'.repeat(101) }],
  ])('paramètre invalide 422 : %s', async (_l, query) => {
    expect((await api().get(URL).query(query).set(p.h)).status).toBe(422);
  });

  test('limit 1000 plafonnée à 100', async () => {
    const res = await api().get(URL).query({ limit: 1000 }).set(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.limit).toBe(100);
  });

  test('tri par nom croissant et décroissant', async () => {
    const asc = (await api().get(URL).query({ tri: 'name', limit: 100 }).set(p.h)).body.data.items.map((b) => b.name);
    const desc = (await api().get(URL).query({ tri: '-name', limit: 100 }).set(p.h)).body.data.items.map((b) => b.name);
    expect(desc).toEqual([...asc].reverse());
  });

  test('filtre ville', async () => {
    const res = await api().get(URL).query({ city: 'Thiès', limit: 100 }).set(p.h);
    expect(res.body.data.pagination.total).toBe(2);
    expect(res.body.data.items.every((b) => b.city === 'Thiès')).toBe(true);
  });

  test.each([
    ['%', ['Écho 100%']],
    ['_', ['Foxtrot_1']],
    ["'", ["L'Oasis"]],
    ['\\', ['Back\\slash']],
    ['Écho', ['Écho 100%']],
    ['cho 1', ['Écho 100%']],
    ['ALPHA', ['Alpha']],
  ])('recherche littérale « %s » (jokers échappés, accents, casse)', async (q, attendus) => {
    const res = await api().get(URL).query({ q, limit: 100 }).set(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((b) => b.name).sort()).toEqual(attendus);
  });

  test.each(["' OR 1=1 --", "'; DROP TABLE buildings; --", '" OR ""="', '%\' UNION SELECT password_hash FROM users --'])(
    'injection SQL « %s » : 200, aucune fuite, table intacte',
    async (q) => {
      const avant = await compter('buildings');
      const res = await api().get(URL).query({ q }).set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
      expect(await compter('buildings')).toBe(avant);
    }
  );
});

describe('Limite de la formule (§ 31)', () => {
  async function formuleLimitee(p, maxBuildings) {
    const admin = await superAdmin();
    const code = `LIM_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    expect((await api().post('/api/v1/admin/plans').set(admin.h).send({ code, name: 'Limitée', price: 1000, max_buildings: maxBuildings, max_apartments: 50 })).status).toBe(201);
    expect((await api().post(`/api/v1/admin/proprietaires/${p.ownerId}/abonnement/activer`).set(admin.h).send({ plan_code: code, months: 1 })).status).toBe(201);
  }

  test('au-delà du maximum d’immeubles : 403 LIMITE_ABONNEMENT', async () => {
    const p = await nouveauProprietaire();
    await formuleLimitee(p, 1);
    await creerImmeuble(p);
    const res = await api().post(URL).set(p.h).send({ name: nomUnique(), address: 'A', city: 'Dakar' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'LIMITE_ABONNEMENT', details: { ressource: 'buildings', max: 1 } });
  });

  test('concurrence : 6 créations simultanées avec une limite de 2 → jamais plus de 2 immeubles', async () => {
    const p = await nouveauProprietaire();
    await formuleLimitee(p, 2);
    const reponses = await Promise.all(Array.from({ length: 6 }, () => api().post(URL).set(p.h).send({ name: nomUnique(), address: 'A', city: 'Dakar' })));
    expect(reponses.filter((r) => r.status === 201)).toHaveLength(2);
    expect(reponses.filter((r) => r.status === 403)).toHaveLength(4);
    expect(await compter('buildings', 'owner_id = :o AND deleted_at IS NULL', { o: p.ownerId })).toBe(2);
  });
});
