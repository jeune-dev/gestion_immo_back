'use strict';

const {
  api, superAdmin, nouveauProprietaire, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * POST /auth/localiser — le portail KODAFRIK demande si le compte est un
 * administrateur de Terangaloc, avant de lui présenter le mot de passe. Sans
 * cette réponse, un mot de passe différent passait pour « pas de compte ».
 */

const URL = '/api/v1/auth/localiser';
afterAll(fermer);

describe('POST /auth/localiser', () => {
  test('un super admin actif est connu, quelle que soit la casse de l’adresse', async () => {
    const admin = await superAdmin();
    const r = await api().post(URL).send({ identifiant: admin.email.toUpperCase() });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ connu: true });
  });

  test('inconnu, propriétaire ou super admin désactivé : la même réponse', async () => {
    expect((await api().post(URL).send({ identifiant: 'personne.inconnue@test.sn' })).body.data).toEqual({ connu: false });

    const proprio = await nouveauProprietaire();
    expect((await api().post(URL).send({ identifiant: proprio.identifiants.email })).body.data).toEqual({ connu: false });

    const admin = await superAdmin();
    await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :id", { replacements: { id: admin.user.id } });
    expect((await api().post(URL).send({ identifiant: admin.email })).body.data).toEqual({ connu: false });
  });

  test('identifiant absent : 422', async () => {
    expect((await api().post(URL).send({})).status).toBe(422);
  });
});
