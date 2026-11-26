'use strict';

const {
  api, superAdmin, nouveauProprietaire, emailUnique, fermer, sequelize, MOT_DE_PASSE,
} = require('../../../setup/helpers.js');

/**
 * Le back-office KODAFRIK modifie et supprime les administrateurs Terangaloc
 * depuis la vue d'ensemble : PATCH et DELETE /admin/utilisateurs/:id.
 */

const URL = '/api/v1/admin/utilisateurs';
afterAll(fermer);

describe('PATCH /admin/utilisateurs/:id', () => {
  test('prénom, nom, e-mail et téléphone ; un e-mail déjà pris est refusé', async () => {
    const admin = await superAdmin();
    const cible = await superAdmin();
    const autre = await superAdmin();
    const email = emailUnique('admin.renomme');

    const r = await api().patch(`${URL}/${cible.user.id}`).set(admin.h)
      .send({ first_name: 'Fatou', last_name: 'Ndiaye', email, phone: '77 555 44 33' });
    expect(r.status).toBe(200);
    expect(r.body.data.user).toMatchObject({ first_name: 'Fatou', last_name: 'Ndiaye', email, phone: '+221775554433' });

    const pris = await api().patch(`${URL}/${cible.user.id}`).set(admin.h).send({ email: autre.email });
    expect(pris.status).toBe(409);
    expect(pris.body.error.code).toBe('IDENTIFIANT_UTILISE');
    expect((await api().patch(`${URL}/${cible.user.id}`).set(admin.h).send({})).status).toBe(422);
  });

  test('un compte qui n’est pas administrateur ne se modifie pas d’ici', async () => {
    const admin = await superAdmin();
    const proprio = await nouveauProprietaire();
    const [[u]] = await sequelize.query('SELECT id FROM users WHERE lower(email) = lower(:e)', { replacements: { e: proprio.identifiants.email } });
    const r = await api().patch(`${URL}/${u.id}`).set(admin.h).send({ first_name: 'X' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ROLE_NON_ADMIN');
  });
});

describe('DELETE /admin/utilisateurs/:id', () => {
  test('supprime un super admin : sessions fermées, e-mail libéré ; jamais soi-même', async () => {
    const admin = await superAdmin();
    const cible = await superAdmin();

    const soi = await api().delete(`${URL}/${admin.user.id}`).set(admin.h);
    expect(soi.status).toBe(409);
    expect(soi.body.error.code).toBe('ACTION_SUR_SOI_INTERDITE');

    const r = await api().delete(`${URL}/${cible.user.id}`).set(admin.h);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id: cible.user.id, supprime: true });

    // Plus de session, plus de connexion, plus de fiche.
    expect((await api().get('/api/v1/compte').set(cible.h)).status).toBe(401);
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: cible.email, password: MOT_DE_PASSE })).status).toBe(401);
    expect((await api().get(`${URL}/${cible.user.id}`).set(admin.h)).status).toBe(404);
    const [[ligne]] = await sequelize.query('SELECT deleted_at FROM users WHERE id = :id', { replacements: { id: cible.user.id } });
    expect(ligne.deleted_at).not.toBeNull();
    expect(await sequelize.query('SELECT 1 FROM code_acces_admin WHERE user_id = :id', { replacements: { id: cible.user.id }, type: 'SELECT' })).toHaveLength(0);
  });

  test('un propriétaire ne se supprime pas d’ici : il se désactive', async () => {
    const admin = await superAdmin();
    const proprio = await nouveauProprietaire();
    const [[u]] = await sequelize.query('SELECT id FROM users WHERE lower(email) = lower(:e)', { replacements: { e: proprio.identifiants.email } });
    const r = await api().delete(`${URL}/${u.id}`).set(admin.h);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ROLE_NON_ADMIN');
  });

  test('introuvable : 404', async () => {
    const admin = await superAdmin();
    expect((await api().delete(`${URL}/3f6c1c2e-0000-4000-8000-000000000000`).set(admin.h)).status).toBe(404);
  });
});
