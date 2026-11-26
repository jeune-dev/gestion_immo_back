'use strict';

const {
  api, bearer, MOT_DE_PASSE, superAdmin, emailUnique, fermer, sequelize, ouvrirAdministration,
} = require('../../../setup/helpers.js');
const bcrypt = require('../../../../utils/motDePasse.js');

/**
 * Le code d'accès à quatre chiffres des super admins (portail KODAFRIK) :
 * EXIGÉ par le serveur pour toute route /admin, en plus du mot de passe ;
 * gardé par la session d'une rotation à l'autre ; changé par un autre super
 * admin ; fixe (0000) pour kodafrik_admin@gmail.com. Et le rétablissement
 * d'accès d'un super admin par un autre.
 */

const ADMIN = '/api/v1/admin';
const VERIFIER = '/api/v1/auth/code-acces/verifier';
const DASHBOARD = `${ADMIN}/dashboard`;

afterAll(fermer);

const verifier = (h, code) => api().post(VERIFIER).set(h).send({ code });
const rafraichir = (refresh) => api().post('/api/v1/auth/refresh').send({ refresh_token: refresh });

describe('Code d’accès exigé par /admin', () => {
  test('mot de passe seul : 403 ; code faux : 401 ; bon code : l’administration s’ouvre', async () => {
    const admin = await superAdmin({ code: false });
    const refus = await api().get(DASHBOARD).set(admin.h);
    expect(refus.status).toBe(403);
    expect(refus.body.error.code).toBe('CODE_ACCES_REQUIS');

    const faux = await verifier(admin.h, '9999');
    expect(faux.status).toBe(401);
    expect(faux.body.error.code).toBe('CODE_ACCES_INCORRECT');
    expect((await verifier(admin.h, '12a4')).status).toBe(422);

    const bon = await verifier(admin.h, admin.code);
    expect(bon.status).toBe(200);
    expect(bon.body.data.valide).toBe(true);
    expect((await api().get(DASHBOARD).set(bearer(bon.body.data.access_token))).status).toBe(200);
  });

  test('la session garde le code vérifié quand elle se renouvelle', async () => {
    const admin = await superAdmin();
    const r = await rafraichir(admin.refreshToken);
    expect(r.status).toBe(200);
    expect((await api().get(DASHBOARD).set(bearer(r.body.data.access_token))).status).toBe(200);
  });

  test('cinq codes faux : compte bloqué 15 min (423), même pour le bon code', async () => {
    const admin = await superAdmin({ code: false });
    for (let i = 0; i < 4; i += 1) expect((await verifier(admin.h, '0000')).status).toBe(401);
    const bloque = await verifier(admin.h, '0000');
    expect(bloque.status).toBe(423);
    expect(bloque.body.error.code).toBe('CODE_ACCES_BLOQUE');
    expect((await verifier(admin.h, admin.code)).status).toBe(423);
  });

  test('aucun code défini : 403 CODE_ACCES_NON_DEFINI', async () => {
    const admin = await superAdmin({ code: false });
    await sequelize.query('DELETE FROM code_acces_admin WHERE user_id = :id', { replacements: { id: admin.user.id } });
    const r = await verifier(admin.h, '1234');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CODE_ACCES_NON_DEFINI');
  });

  test('un propriétaire n’a pas de code d’accès', async () => {
    const admin = await superAdmin();
    await sequelize.query("UPDATE users SET role_code = 'proprietaire' WHERE id = :id", { replacements: { id: admin.user.id } });
    expect((await verifier(admin.h, admin.code)).status).toBe(403);
  });
});

describe('PUT /admin/utilisateurs/:id/code-acces', () => {
  test('un autre super admin change le code : l’ancien ne vaut plus, la session le redemande', async () => {
    const admin = await superAdmin();
    const cible = await superAdmin();
    const url = `${ADMIN}/utilisateurs/${cible.user.id}/code-acces`;

    expect((await api().put(url).set(admin.h).send({ code_acces: '12' })).status).toBe(422);
    const ok = await api().put(url).set(admin.h).send({ code_acces: '5831' });
    expect(ok.status).toBe(200);

    // La session déjà vérifiée perd son drapeau : le jeton suivant ne l'a plus.
    const r = await rafraichir(cible.refreshToken);
    expect(r.status).toBe(200);
    const h = bearer(r.body.data.access_token);
    expect((await api().get(DASHBOARD).set(h)).status).toBe(403);
    expect((await verifier(h, cible.code)).status).toBe(401);
    expect((await verifier(h, '5831')).status).toBe(200);
  });

  test('un compte qui n’est pas super admin n’a pas de code d’accès : 404', async () => {
    const admin = await superAdmin();
    const [[proprio]] = await sequelize.query(
      `INSERT INTO users (role_code, first_name, last_name, email, password_hash)
       VALUES ('proprietaire', 'P', 'Q', :email, :h) RETURNING id`,
      { replacements: { email: emailUnique('proprio.code'), h: await bcrypt.hash(MOT_DE_PASSE, 4) } },
    );
    expect((await api().put(`${ADMIN}/utilisateurs/${proprio.id}/code-acces`).set(admin.h).send({ code_acces: '1234' })).status).toBe(404);
  });

  test('kodafrik_admin@gmail.com : 0000 seul, et ce code ne se change pas (409)', async () => {
    const admin = await superAdmin();
    await sequelize.query("DELETE FROM users WHERE lower(email) = 'kodafrik_admin@gmail.com'");
    const [[fixe]] = await sequelize.query(
      `INSERT INTO users (role_code, first_name, last_name, email, password_hash)
       VALUES ('super_admin', 'Kodafrik', 'Admin', 'kodafrik_admin@gmail.com', :h) RETURNING id`,
      { replacements: { h: await bcrypt.hash(MOT_DE_PASSE, 4) } },
    );
    const refus = await api().put(`${ADMIN}/utilisateurs/${fixe.id}/code-acces`).set(admin.h).send({ code_acces: '1111' });
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('CODE_ACCES_FIXE');

    const c = await api().post('/api/v1/auth/connexion').send({ identifiant: 'kodafrik_admin@gmail.com', password: MOT_DE_PASSE });
    expect(c.status).toBe(200);
    const h = bearer(c.body.data.access_token);
    expect((await verifier(h, '1111')).status).toBe(401);
    const ok = await verifier(h, '0000');
    expect(ok.status).toBe(200);
    expect((await api().get(DASHBOARD).set(bearer(ok.body.data.access_token))).status).toBe(200);
  });
});

describe('POST /admin/utilisateurs/:id/reinitialiser-acces', () => {
  test('mot de passe provisoire, sessions fermées ; refus sur soi-même et sans le bon mot de passe', async () => {
    const admin = await superAdmin();
    const cible = await superAdmin();
    const url = `${ADMIN}/utilisateurs/${cible.user.id}/reinitialiser-acces`;

    expect((await api().post(url).set(admin.h).send({ current_password: 'faux', reason: 'Téléphone perdu' })).status).toBe(401);
    expect((await api().post(`${ADMIN}/utilisateurs/${admin.user.id}/reinitialiser-acces`).set(admin.h)
      .send({ current_password: MOT_DE_PASSE, reason: 'soi-même' })).status).toBe(409);

    const res = await api().post(url).set(admin.h).send({ current_password: MOT_DE_PASSE, reason: 'Téléphone perdu' });
    expect(res.status).toBe(200);
    const provisoire = res.body.data.mot_de_passe_provisoire;
    expect(provisoire.length).toBeGreaterThanOrEqual(12);
    expect(res.body.data.user.must_change_password).toBe(true);

    // Les sessions de la cible sont fermées.
    expect((await api().get('/api/v1/compte').set(cible.h)).status).toBe(401);
    // Elle revient avec le provisoire, qu'elle doit changer, puis son code d'accès.
    const c = await api().post('/api/v1/auth/connexion').send({ identifiant: cible.email, password: provisoire });
    expect(c.status).toBe(200);
    expect(c.body.data.user.must_change_password).toBe(true);
    const nouveau = 'Zt7$pWq4!nBv';
    const change = await api().post('/api/v1/compte/mot-de-passe').set(bearer(c.body.data.access_token))
      .send({ current_password: provisoire, password: nouveau, password_confirmation: nouveau });
    expect(change.status).toBe(200);
    const h = await ouvrirAdministration(cible.user.id, bearer(change.body.data.access_token));
    expect((await api().get(DASHBOARD).set(h)).status).toBe(200);
  });
});
