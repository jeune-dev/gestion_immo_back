'use strict';

const {
  api, bearer, MOT_DE_PASSE, superAdmin, emailUnique, fermer,
} = require('../../../setup/helpers.js');

/**
 * Permissions d'un super admin, compte par compte (back-office KODAFRIK) :
 * créé avec une liste de permissions `admin.*`, il n'ouvre que ces pages-là ;
 * NULL (ou toutes cochées) = tout, comme avant.
 */

const URL = '/api/v1/admin/utilisateurs';
const MDP = 'Xk9#vLq2!mRt';
const NOUVEAU = 'Zt7$pWq4!nBv';

afterAll(fermer);

/** Crée un super admin restreint, et le connecte (mot de passe provisoire changé). */
async function adminRestreint(admin, permissions) {
  const email = emailUnique('admin.restreint');
  const cree = await api().post(URL).set(admin.h).send({
    first_name: 'Awa', last_name: 'Sow', email, password: MDP, current_password: MOT_DE_PASSE, permissions,
  });
  expect(cree.status).toBe(201);
  const connexion = await api().post('/api/v1/auth/connexion').send({ identifiant: email, password: MDP });
  const change = await api().post('/api/v1/compte/mot-de-passe').set(bearer(connexion.body.data.access_token))
    .send({ current_password: MDP, password: NOUVEAU, password_confirmation: NOUVEAU });
  expect(change.status).toBe(200);
  return { id: cree.body.data.user.id, h: bearer(change.body.data.access_token), user: cree.body.data.user };
}

describe('Permissions d’un super administrateur', () => {
  test('créé avec des permissions choisies : seules ces pages s’ouvrent', async () => {
    const admin = await superAdmin();
    const r = await adminRestreint(admin, ['admin.dashboard', 'admin.proprietaires']);
    expect(r.user.admin_permissions).toEqual(['admin.dashboard', 'admin.proprietaires']);
    expect((await api().get('/api/v1/admin/dashboard').set(r.h)).status).toBe(200);
    const refus = await api().get(URL).set(r.h);
    expect(refus.status).toBe(403);
    expect(refus.body.error.code).toBe('PERMISSION_REFUSEE');
  });

  test('modification : effet immédiat ; toutes cochées = aucune restriction', async () => {
    const admin = await superAdmin();
    const r = await adminRestreint(admin, ['admin.dashboard']);
    const maj = await api().put(`${URL}/${r.id}/permissions`).set(admin.h).send({ permissions: ['admin.dashboard', 'admin.utilisateurs'] });
    expect(maj.status).toBe(200);
    expect((await api().get(URL).set(r.h)).status).toBe(200);
    const tout = await api().put(`${URL}/${r.id}/permissions`).set(admin.h).send({ permissions: null });
    expect(tout.body.data.user.admin_permissions).toBeNull();
  });

  test('refus : ses propres permissions, une permission inconnue', async () => {
    const admin = await superAdmin();
    const soi = await api().put(`${URL}/${admin.user.id}/permissions`).set(admin.h).send({ permissions: ['admin.dashboard'] });
    expect(soi.status).toBe(409);
    expect(soi.body.error.code).toBe('ACTION_SUR_SOI_INTERDITE');
    const r = await adminRestreint(admin, null);
    expect((await api().put(`${URL}/${r.id}/permissions`).set(admin.h).send({ permissions: ['proprietaire.tout'] })).status).toBe(400);
  });
});
