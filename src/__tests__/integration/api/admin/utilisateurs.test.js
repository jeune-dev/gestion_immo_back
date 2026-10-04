'use strict';

const {
  api, bearer, MOT_DE_PASSE, nouveauProprietaire, superAdmin, emailUnique, telephoneUnique, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');
const utilisateurs = require('../../../../modules/admin/service/utilisateurs.service.js');

/**
 * § 30 « Utilisateurs », § 32 comptes actifs / inactifs, verrouillage,
 * déconnexion distante — et garantie qu'il reste toujours un super admin actif.
 */

const URL = '/api/v1/admin/utilisateurs';
const INCONNU = '00000000-0000-4000-8000-000000000000';
const MDP_ADMIN = 'Xk9#vLq2!mRt';

afterAll(fermer);

/**
 * Ne laisse actifs QUE les super admins indiqués le temps d'un test (les
 * autres — dont le compte initial semé — sont réactivés ensuite).
 */
async function seulsActifs(ids, fn) {
  const [autres] = await sequelize.query(
    "UPDATE users SET status = 'inactif' WHERE role_code = 'super_admin' AND status = 'actif' AND id NOT IN (:ids) RETURNING id",
    { replacements: { ids } }
  );
  try {
    await fn();
  } finally {
    if (autres.length) await sequelize.query("UPDATE users SET status = 'actif' WHERE id IN (:ids)", { replacements: { ids: autres.map((a) => a.id) } });
  }
}

describe('Liste et détail', () => {
  let admin;
  beforeAll(async () => { admin = await superAdmin(); });

  test('filtres rôle, statut, verrouillage, recherche ; aucune colonne secrète', async () => {
    const p = await nouveauProprietaire({ first_name: 'Ousmane', last_name: 'Zz_Unique%' });
    const res = await api().get(URL).query({ q: 'Zz_Unique%', role: 'proprietaire', status: 'actif' }).set(admin.h);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((u) => u.id)).toEqual([p.user.id]);
    expect(res.body.data.items[0]).toMatchObject({ role_code: 'proprietaire', is_locked: false });
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|token_version|failed_login_attempts|locked_until/);

    const admins = await api().get(URL).query({ role: 'super_admin', limit: 100 }).set(admin.h);
    expect(admins.body.data.items.every((u) => u.role_code === 'super_admin')).toBe(true);
    expect(admins.body.data.pagination.total).toBe(await compter('users', "role_code = 'super_admin' AND deleted_at IS NULL"));

    const nonVerrouilles = await api().get(URL).query({ verrouille: false, q: 'Zz_Unique%' }).set(admin.h);
    expect(nonVerrouilles.body.data.items.map((u) => u.id)).toEqual([p.user.id]);
  });

  test('recherche : injection SQL sans effet, jokers littéraux', async () => {
    const avant = await compter('users');
    for (const q of ["' OR 1=1 --", "'; DROP TABLE users; --", '%%%', '___']) {
      const res = await api().get(URL).query({ q }).set(admin.h);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    }
    expect(await compter('users')).toBe(avant);
  });

  test('tri et pagination exacts, paramètres invalides 422', async () => {
    const res = await api().get(URL).query({ tri: '-last_login_at', limit: 2, page: 1 }).set(admin.h);
    expect(res.status).toBe(200);
    const total = await compter('users', 'deleted_at IS NULL');
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 2, total, totalPages: Math.ceil(total / 2) });
    for (const query of [{ role: 'agence' }, { status: 'banni' }, { tri: 'password_hash' }, { verrouille: 'peut-etre' }, { page: 0 }, { limit: 'x' }]) {
      expect((await api().get(URL).query(query).set(admin.h)).status).toBe(422);
    }
    expect((await api().get(URL).query({ limit: 500 }).set(admin.h)).body.data.pagination.limit).toBe(100);
  });

  test('détail : appartenances, sessions actives ; 404 inconnu ; 422 identifiant invalide', async () => {
    const p = await nouveauProprietaire();
    const res = await api().get(`${URL}/${p.user.id}`).set(admin.h);
    expect(res.body.data.user).toMatchObject({ id: p.user.id, active_sessions: 1, memberships: [{ owner_id: p.ownerId, role_code: 'proprietaire' }] });
    expect((await api().get(`${URL}/${INCONNU}`).set(admin.h)).status).toBe(404);
    expect((await api().get(`${URL}/1`).set(admin.h)).status).toBe(422);
  });
});

describe('Création d’un super admin', () => {
  let admin;
  beforeAll(async () => { admin = await superAdmin(); });

  test('nominal : 201, changement exigé, audit, empreinte bcrypt', async () => {
    const email = emailUnique('nouvel.admin');
    const res = await api().post(URL).set(admin.h).send({ current_password: MOT_DE_PASSE, first_name: 'Awa', last_name: 'Sow', email, phone: telephoneUnique(), password: MDP_ADMIN, role_code: 'proprietaire', status: 'inactif' });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ role_code: 'super_admin', status: 'actif', must_change_password: true, email });
    const [[audit]] = await sequelize.query("SELECT user_id, details FROM audit_logs WHERE action = 'utilisateur.creation' AND entity_id = :id", { replacements: { id: res.body.data.user.id } });
    expect(audit).toMatchObject({ user_id: admin.user.id, details: { role: 'super_admin', email } });
    expect(JSON.stringify(audit.details)).not.toContain(MDP_ADMIN);
  });

  test.each([
    ['11 caractères', 'Xk9#vLq2!mR'],
    ['sans caractère spécial', 'Xk9vLq2mRtAb'],
    ['sans majuscule', 'xk9#vlq2!mrt'],
    ['motif prévisible', 'Admin#2026xyz'],
    ['contient la partie locale de l’e-mail', 'Mamadou#2026x'],
  ])('mot de passe refusé (422 MOT_DE_PASSE_FAIBLE) : %s', async (_l, password) => {
    const res = await api().post(URL).set(admin.h).send({ current_password: MOT_DE_PASSE, first_name: 'A', last_name: 'B', email: `mamadou@d${Date.now()}.sn`, password });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MOT_DE_PASSE_FAIBLE');
  });

  test.each([
    ['e-mail manquant', { first_name: 'A', last_name: 'B', password: MDP_ADMIN }],
    ['e-mail invalide', { first_name: 'A', last_name: 'B', email: 'x', password: MDP_ADMIN }],
    ['prénom manquant', { last_name: 'B', email: 'a@b.sn', password: MDP_ADMIN }],
    ['téléphone invalide', { first_name: 'A', last_name: 'B', email: 'a@b.sn', phone: '12', password: MDP_ADMIN }],
    ['mot de passe de 129 caractères', { first_name: 'A', last_name: 'B', email: 'a@b.sn', password: `Aa1#${'x'.repeat(125)}` }],
  ])('validation 422 : %s', async (_l, corps) => {
    expect((await api().post(URL).set(admin.h).send(corps)).status).toBe(422);
  });

  test('e-mail ou téléphone déjà utilisé : 409 IDENTIFIANT_UTILISE', async () => {
    const p = await nouveauProprietaire();
    const parEmail = await api().post(URL).set(admin.h).send({ current_password: MOT_DE_PASSE, first_name: 'A', last_name: 'B', email: p.identifiants.email.toUpperCase(), password: MDP_ADMIN });
    expect(parEmail.status).toBe(409);
    expect(parEmail.body.error.code).toBe('IDENTIFIANT_UTILISE');
    const parTel = await api().post(URL).set(admin.h).send({ current_password: MOT_DE_PASSE, first_name: 'A', last_name: 'B', email: emailUnique(), phone: p.identifiants.phone, password: MDP_ADMIN });
    expect(parTel.status).toBe(409);
  });
});

describe('Désactivation, activation, déverrouillage', () => {
  let admin;
  beforeAll(async () => { admin = await superAdmin(); });

  test('désactivation : sessions fermées, audit avec motif ; déjà inactif 409 ; motif obligatoire (3 à 1000 caractères)', async () => {
    const p = await nouveauProprietaire();
    const url = `${URL}/${p.user.id}`;
    expect((await api().post(`${url}/desactiver`).set(admin.h).send({})).status).toBe(422);
    expect((await api().post(`${url}/desactiver`).set(admin.h).send({ reason: 'ab' })).status).toBe(422);
    expect((await api().post(`${url}/desactiver`).set(admin.h).send({ reason: 'x'.repeat(1001) })).status).toBe(422);
    const res = await api().post(`${url}/desactiver`).set(admin.h).send({ reason: 'Fraude avérée' });
    expect(res.status).toBe(200);
    expect(await compter('refresh_tokens', 'user_id = :u AND revoked_at IS NULL', { u: p.user.id })).toBe(0);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: p.refreshToken })).status).toBe(401);
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'utilisateur.changement_statut' AND entity_id = :u", { replacements: { u: p.user.id } });
    expect(audit.details).toMatchObject({ de: 'actif', a: 'inactif', motif: 'Fraude avérée', role: 'proprietaire' });
    const deja = await api().post(`${url}/desactiver`).set(admin.h).send({ reason: 'Encore' });
    expect(deja.status).toBe(409);
    expect(deja.body.error.code).toBe('DEJA_INACTIF');
  });

  test('activation : déjà actif 409 DEJA_ACTIF ; 404 inconnu', async () => {
    const p = await nouveauProprietaire();
    const res = await api().post(`${URL}/${p.user.id}/activer`).set(admin.h).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEJA_ACTIF');
    for (const action of ['activer', 'desactiver', 'deverrouiller']) {
      expect((await api().post(`${URL}/${INCONNU}/${action}`).set(admin.h).send({ reason: 'Motif valable' })).status).toBe(404);
    }
  });

  test('déverrouillage : compteur et blocage remis à zéro, audit', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE users SET failed_login_attempts = 5, locked_until = now() + interval '1 hour' WHERE id = :u", { replacements: { u: p.user.id } });
    const res = await api().post(`${URL}/${p.user.id}/deverrouiller`).set(admin.h).send({});
    expect(res.body.data.user.is_locked).toBe(false);
    const [[u]] = await sequelize.query('SELECT failed_login_attempts, locked_until FROM users WHERE id = :u', { replacements: { u: p.user.id } });
    expect(u).toEqual({ failed_login_attempts: 0, locked_until: null });
    expect(await compter('audit_logs', "action = 'utilisateur.deverrouillage' AND entity_id = :u", { u: p.user.id })).toBe(1);
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE })).status).toBe(200);
  });
});

describe('CORRECTIF : jamais zéro super admin actif', () => {
  test('désactivation séquentielle du dernier super admin actif (service) → 409 DERNIER_SUPER_ADMIN', async () => {
    const a = await superAdmin();
    await seulsActifs([a.user.id], async () => {
      const acteur = { id: INCONNU };
      await expect(utilisateurs.desactiver(acteur, a.user.id, { reason: 'Test du dernier admin' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'DERNIER_SUPER_ADMIN' });
      expect(await compter('users', "id = :id AND status = 'actif'", { id: a.user.id })).toBe(1);
    });
  });

  test('deux super admins : A désactive B → accepté, A reste seul actif et ne peut se désactiver', async () => {
    const a = await superAdmin();
    const b = await superAdmin();
    await seulsActifs([a.user.id, b.user.id], async () => {
      expect((await api().post(`${URL}/${b.user.id}/desactiver`).set(a.h).send({ reason: 'Départ de B' })).status).toBe(200);
      expect((await api().post(`${URL}/${a.user.id}/desactiver`).set(a.h).send({ reason: 'Erreur' })).body.error.code).toBe('ACTION_SUR_SOI_INTERDITE');
      expect(await compter('users', "role_code = 'super_admin' AND status = 'actif'")).toBe(1);
      await sequelize.query("UPDATE users SET status = 'actif' WHERE id = :id", { replacements: { id: b.user.id } });
    });
  });

  test('concurrence : deux super admins se désactivent MUTUELLEMENT au même instant → un seul y parvient', async () => {
    const a = await superAdmin();
    const b = await superAdmin();
    await seulsActifs([a.user.id, b.user.id], async () => {
      const [ab, ba] = await Promise.all([
        api().post(`${URL}/${b.user.id}/desactiver`).set(a.h).send({ reason: 'Course A' }),
        api().post(`${URL}/${a.user.id}/desactiver`).set(b.h).send({ reason: 'Course B' }),
      ]);
      // Exactement UN succès. Le perdant est refusé soit par le contrôle du
      // dernier super admin (409, requêtes réellement simultanées), soit — si
      // la désactivation gagnante est déjà validée quand sa requête arrive —
      // parce que son propre compte est désormais inactif (403). Dans les deux
      // cas l'invariant tient : il reste un super admin actif.
      const gagnant = [ab, ba].filter((r) => r.status === 200);
      const perdant = [ab, ba].find((r) => r.status !== 200);
      expect(gagnant).toHaveLength(1);
      expect([[409, 'DERNIER_SUPER_ADMIN'], [403, 'COMPTE_INACTIF']]).toContainEqual([perdant.status, perdant.body.error.code]);
      expect(await compter('users', "role_code = 'super_admin' AND status = 'actif' AND id IN (:ids)", { ids: [a.user.id, b.user.id] })).toBe(1);
      await sequelize.query("UPDATE users SET status = 'actif' WHERE id IN (:ids)", { replacements: { ids: [a.user.id, b.user.id] } });
    });
  });

  test('désactiver un super admin quand d’autres restent actifs : permis, sa session tombe', async () => {
    const a = await superAdmin();
    const b = await superAdmin();
    expect((await api().post(`${URL}/${b.user.id}/desactiver`).set(a.h).send({ reason: 'Rotation' })).status).toBe(200);
    expect((await api().get('/api/v1/admin/dashboard').set(bearer(b.token))).body.error.code).toBe('COMPTE_INACTIF');
  });
});
