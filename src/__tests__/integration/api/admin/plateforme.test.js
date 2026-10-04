'use strict';

const crypto = require('crypto');
const {
  api, superAdmin, nouveauProprietaire, proprietaireEtLocataire, creerImmeuble, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 30 « Paramètres », « Notifications », « Catégories » ; § 40 journal
 * d'audit ; § 32 rôles (lecture seule).
 */

const BASE = '/api/v1/admin';
const INCONNU = '00000000-0000-4000-8000-000000000000';

let admin;
beforeAll(async () => { admin = await superAdmin(); });
afterAll(fermer);

describe('Paramètres plateforme', () => {
  test('liste : valeur effective, défaut, personnalisation', async () => {
    const res = await api().get(`${BASE}/parametres`).set(admin.h);
    expect(res.status).toBe(200);
    const otp = res.body.data.settings.find((s) => s.key === 'otp');
    expect(otp).toMatchObject({ default: { duree_minutes: 15, tentatives_max: 5 }, value: expect.any(Object) });
  });

  test.each([
    ['otp', { duree_minutes: 4, tentatives_max: 5 }],
    ['otp', { duree_minutes: 15, tentatives_max: 11 }],
    ['otp', { duree_minutes: 15 }],
    ['paiement', { expiration_minutes: 1441 }],
    ['paiement', { expiration_minutes: 'trente' }],
    ['essai', { plan_code: 'BUSINESS', duree_jours: 91 }],
    ['essai', { duree_jours: 14 }],
    ['invitation', { duree_jours: 0 }],
    ['invitation', {}],
  ])('clé « %s » : valeur hors bornes %j → 422, rien n’est écrit', async (cle, corps) => {
    const avant = await compter('audit_logs', "action = 'parametre_plateforme.modification'");
    expect((await api().put(`${BASE}/parametres/${cle}`).set(admin.h).send(corps)).status).toBe(422);
    expect(await compter('audit_logs', "action = 'parametre_plateforme.modification'")).toBe(avant);
  });

  test('essai sur une formule inactive : 422 PLAN_INDISPONIBLE', async () => {
    const code = `INA_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const plan = (await api().post(`${BASE}/plans`).set(admin.h).send({ code, name: 'Inactive', price: 1 })).body.data.plan;
    await api().post(`${BASE}/plans/${plan.id}/desactiver`).set(admin.h).send({});
    const res = await api().put(`${BASE}/parametres/essai`).set(admin.h).send({ plan_code: code, duree_jours: 7 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PLAN_INDISPONIBLE');
  });

  test('modification OTP : prise en compte immédiate (cache invalidé), clés inconnues ignorées, auteur enregistré', async () => {
    const res = await api().put(`${BASE}/parametres/otp`).set(admin.h).send({ duree_minutes: 10, tentatives_max: 3, pirate: 'x' });
    try {
      expect(res.status).toBe(200);
      expect(res.body.data.setting).toMatchObject({ key: 'otp', value: { duree_minutes: 10, tentatives_max: 3 }, customized: true, updated_by: admin.user.id });
      expect(res.body.data.setting.value).not.toHaveProperty('pirate');
    } finally {
      await api().put(`${BASE}/parametres/otp`).set(admin.h).send({ duree_minutes: 15, tentatives_max: 5 });
    }
  });

  test('clé inconnue : 404 ; clé de 81 caractères : 422', async () => {
    expect((await api().put(`${BASE}/parametres/inconnue`).set(admin.h).send({})).status).toBe(404);
    expect((await api().put(`${BASE}/parametres/${'k'.repeat(81)}`).set(admin.h).send({})).status).toBe(422);
  });
});

describe('Notifications diffusées', () => {
  test('cible « locataires » : seulement les comptes locataires actifs ; historique paginé', async () => {
    const { locataire, proprio } = await proprietaireEtLocataire();
    const titre = `Info ${crypto.randomBytes(3).toString('hex')}`;
    const attendus = await compter('users', "role_code = 'locataire' AND status = 'actif' AND deleted_at IS NULL");
    const res = await api().post(`${BASE}/notifications`).set(admin.h).send({ cible: 'locataires', titre, corps: 'Coupure d’eau prévue.' });
    expect(res.status).toBe(201);
    expect(res.body.data.diffusion).toEqual({ cible: 'locataires', destinataires: attendus });
    expect(await compter('notifications', 'title = :t AND user_id = :u', { t: titre, u: locataire.user.id })).toBe(1);
    expect(await compter('notifications', 'title = :t AND user_id = :u', { t: titre, u: proprio.user.id })).toBe(0);
    const historique = await api().get(`${BASE}/notifications`).query({ limit: 1 }).set(admin.h);
    expect(historique.body.data.items).toHaveLength(1);
    expect(historique.body.data.items[0].details).toMatchObject({ cible: 'locataires', titre });
    expect(historique.body.data.pagination.total).toBe(await compter('audit_logs', "action = 'admin.notification_diffusion'"));
  });

  test.each([
    ['cible manquante', { titre: 'Titre', corps: 'Corps' }],
    ['titre de 2 caractères', { cible: 'tous', titre: 'Ti', corps: 'Corps' }],
    ['titre de 151 caractères', { cible: 'tous', titre: 't'.repeat(151), corps: 'Corps' }],
    ['corps de 2001 caractères', { cible: 'tous', titre: 'Titre', corps: 'c'.repeat(2001) }],
    ['corps vide', { cible: 'tous', titre: 'Titre', corps: '' }],
  ])('validation 422 : %s — aucune notification', async (_l, corps) => {
    const avant = await compter('notifications');
    expect((await api().post(`${BASE}/notifications`).set(admin.h).send(corps)).status).toBe(422);
    expect(await compter('notifications')).toBe(avant);
  });

  test('historique : pagination invalide 422', async () => {
    expect((await api().get(`${BASE}/notifications`).query({ page: 0 }).set(admin.h)).status).toBe(422);
  });
});

describe('Catégories globales', () => {
  const code = () => `c_${crypto.randomBytes(4).toString('hex')}`;

  test('création : owner_id toujours NULL, audit ; liste avec compteur d’usage', async () => {
    const p = await nouveauProprietaire();
    const res = await api().post(`${BASE}/categories`).set(admin.h).send({ code: code(), name: 'Gardiennage', cash_group: 'entretien', owner_id: p.ownerId });
    expect(res.status).toBe(201);
    expect(res.body.data.category.owner_id).toBeNull();
    expect(await compter('audit_logs', "action = 'categorie_depense.creation' AND entity_id = :id", { id: res.body.data.category.id })).toBe(1);
    const liste = await api().get(`${BASE}/categories`).set(admin.h);
    expect(liste.body.data.categories.find((c) => c.id === res.body.data.category.id)).toMatchObject({ expenses_count: 0, is_active: true });
  });

  test.each([
    ['code manquant', { name: 'X', cash_group: 'autre' }],
    ['code en majuscules invalides', { code: '9abc', name: 'X', cash_group: 'autre' }],
    ['code avec tiret', { code: 'mon-code', name: 'X', cash_group: 'autre' }],
    ['nom manquant', { code: 'abc_ok', cash_group: 'autre' }],
    ['nom de 101 caractères', { code: 'abc_ok', name: 'n'.repeat(101), cash_group: 'autre' }],
    ['groupe inconnu', { code: 'abc_ok', name: 'X', cash_group: 'loisirs' }],
    ['ordre négatif', { code: 'abc_ok', name: 'X', cash_group: 'autre', sort_order: -1 }],
  ])('validation 422 : %s', async (_l, corps) => {
    expect((await api().post(`${BASE}/categories`).set(admin.h).send(corps)).status).toBe(422);
  });

  test('catégorie PERSONNELLE d’un propriétaire : hors périmètre admin (404)', async () => {
    const p = await nouveauProprietaire();
    const [[cat]] = await sequelize.query(
      "INSERT INTO expense_categories (owner_id, code, name, cash_group, is_active, sort_order) VALUES (:o, :c, 'Perso', 'autre', true, 0) RETURNING id",
      { replacements: { o: p.ownerId, c: code() } }
    );
    expect((await api().patch(`${BASE}/categories/${cat.id}`).set(admin.h).send({ name: 'Piratée' })).status).toBe(404);
    expect((await api().delete(`${BASE}/categories/${cat.id}`).set(admin.h)).status).toBe(404);
    expect((await api().post(`${BASE}/categories/${cat.id}/desactiver`).set(admin.h).send({})).status).toBe(404);
    const [[ligne]] = await sequelize.query('SELECT name, is_active FROM expense_categories WHERE id = :id', { replacements: { id: cat.id } });
    expect(ligne).toEqual({ name: 'Perso', is_active: true });
  });

  test('activation / désactivation : statut inchangé 409 ; modification vide 422 ; inconnue 404', async () => {
    const c = (await api().post(`${BASE}/categories`).set(admin.h).send({ code: code(), name: 'Temp', cash_group: 'autre' })).body.data.category;
    expect((await api().post(`${BASE}/categories/${c.id}/activer`).set(admin.h).send({})).body.error.code).toBe('STATUT_INCHANGE');
    expect((await api().post(`${BASE}/categories/${c.id}/desactiver`).set(admin.h).send({})).status).toBe(200);
    expect((await api().post(`${BASE}/categories/${c.id}/desactiver`).set(admin.h).send({})).status).toBe(409);
    expect((await api().get(`${BASE}/categories`).query({ is_active: true }).set(admin.h)).body.data.categories.map((x) => x.id)).not.toContain(c.id);
    expect((await api().patch(`${BASE}/categories/${c.id}`).set(admin.h).send({})).status).toBe(422);
    expect((await api().patch(`${BASE}/categories/${INCONNU}`).set(admin.h).send({ name: 'X' })).status).toBe(404);
    expect((await api().get(`${BASE}/categories`).query({ is_active: 'parfois' }).set(admin.h)).status).toBe(422);
  });
});

describe('Journal d’audit (§ 40)', () => {
  test('filtres propriétaire, utilisateur, action (préfixe littéral), entité, période ; pagination', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    await api().patch(`/api/v1/immeubles/${b.id}`).set(p.h).send({ city: 'Mbour' });

    const parOwner = await api().get(`${BASE}/journal-audit`).query({ owner_id: p.ownerId, limit: 100 }).set(admin.h);
    expect(parOwner.status).toBe(200);
    expect(parOwner.body.data.items.every((l) => l.owner_id === p.ownerId)).toBe(true);
    expect(parOwner.body.data.pagination.total).toBe(await compter('audit_logs', 'owner_id = :o', { o: p.ownerId }));

    const parEntite = await api().get(`${BASE}/journal-audit`).query({ entity_type: 'building', entity_id: b.id }).set(admin.h);
    expect(parEntite.body.data.items.map((l) => l.action)).toEqual(['immeuble.modification', 'immeuble.creation']);
    expect(parEntite.body.data.items[0]).toMatchObject({ user_id: p.user.id, details: { city: { avant: 'Dakar', apres: 'Mbour' } } });

    const parUser = await api().get(`${BASE}/journal-audit`).query({ user_id: p.user.id, action: 'immeuble.' }).set(admin.h);
    expect(parUser.body.data.pagination.total).toBe(2);

    // « % » et « _ » sont littéraux dans le préfixe d'action.
    expect((await api().get(`${BASE}/journal-audit`).query({ action: '%' }).set(admin.h)).body.data.items).toEqual([]);
    expect((await api().get(`${BASE}/journal-audit`).query({ action: '_mmeuble' }).set(admin.h)).body.data.items).toEqual([]);

    const futur = await api().get(`${BASE}/journal-audit`).query({ owner_id: p.ownerId, du: '2099-01-01' }).set(admin.h);
    expect(futur.body.data.items).toEqual([]);
    const passe = await api().get(`${BASE}/journal-audit`).query({ owner_id: p.ownerId, au: '2000-01-01' }).set(admin.h);
    expect(passe.body.data.items).toEqual([]);
  });

  test.each([
    ['owner_id non UUID', { owner_id: 'x' }], ['user_id non UUID', { user_id: "' OR 1=1 --" }], ['date invalide', { au: '2026-1-1' }],
    ['action de 81 caractères', { action: 'a'.repeat(81) }], ['page -1', { page: -1 }],
  ])('paramètre invalide 422 : %s', async (_l, query) => {
    expect((await api().get(`${BASE}/journal-audit`).query(query).set(admin.h)).status).toBe(422);
  });

  test('injection dans les filtres texte : 200, journal intact', async () => {
    const avant = await compter('audit_logs');
    const res = await api().get(`${BASE}/journal-audit`).query({ action: "'; DROP TABLE audit_logs; --", entity_type: "' OR 1=1 --" }).set(admin.h);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(await compter('audit_logs')).toBeGreaterThanOrEqual(avant);
  });
});

describe('Rôles', () => {
  test('rôles système et catalogue : permissions admin réservées au super admin', async () => {
    const res = await api().get(`${BASE}/roles`).set(admin.h);
    expect(res.status).toBe(200);
    const roles = Object.fromEntries(res.body.data.roles.map((r) => [r.code, r.permissions]));
    expect(roles.super_admin.every((p) => p.startsWith('admin.'))).toBe(true);
    expect(roles.proprietaire.some((p) => p.startsWith('admin.'))).toBe(false);
    expect(roles.locataire.every((p) => p.startsWith('locataire.'))).toBe(true);
    expect(res.body.data.catalogue).toEqual(expect.arrayContaining([...roles.super_admin, ...roles.proprietaire, ...roles.locataire]));
  });
});
