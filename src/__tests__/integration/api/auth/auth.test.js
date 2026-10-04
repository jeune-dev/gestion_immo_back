'use strict';

const {
  api, bearer, MOT_DE_PASSE, nouveauProprietaire, telephoneUnique, emailUnique, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 5 Authentification et § 32 Sécurité : inscription, connexion par téléphone
 * ou e-mail, rotation du refresh token, rejeu, verrouillage, révocation.
 */
describe('Authentification', () => {
  afterAll(fermer);

  test('inscription : compte, espace propriétaire et essai créés ; mot de passe jamais renvoyé', async () => {
    const p = await nouveauProprietaire();
    expect(p.user.role).toBe('proprietaire');
    expect(p.user).not.toHaveProperty('password_hash');
    const res = await api().get('/api/v1/compte').set(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data.abonnement.abonnement.status).toBe('essai');
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|token_version/);
  });

  test('inscription : confirmation différente et e-mail déjà pris refusés', async () => {
    const corps = {
      first_name: 'A', last_name: 'B', phone: telephoneUnique(), email: emailUnique(), password: MOT_DE_PASSE, password_confirmation: 'Autre1234',
    };
    expect((await api().post('/api/v1/auth/inscription').send(corps)).status).toBe(422);
    const p = await nouveauProprietaire();
    const doublon = await api().post('/api/v1/auth/inscription')
      .send({ ...corps, password_confirmation: MOT_DE_PASSE, email: p.identifiants.email });
    expect(doublon.status).toBe(409);
  });

  test('connexion par téléphone (format national) et par e-mail', async () => {
    const p = await nouveauProprietaire();
    const national = p.identifiants.phone.replace('+221', '');
    const parTel = await api().post('/api/v1/auth/connexion').send({ identifiant: national, password: MOT_DE_PASSE });
    expect(parTel.status).toBe(200);
    const parEmail = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email.toUpperCase(), password: MOT_DE_PASSE });
    expect(parEmail.status).toBe(200);
    expect(parEmail.body.data.refresh_token).toBeTruthy();
  });

  test('client navigateur : refresh token en cookie httpOnly, jamais dans le corps', async () => {
    const p = await nouveauProprietaire();
    const res = await api().post('/api/v1/auth/connexion').set('Origin', 'http://localhost:5173')
      .send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE });
    expect(res.status).toBe(200);
    expect(res.body.data.refresh_token).toBeUndefined();
    expect(res.headers['set-cookie'].join(';')).toMatch(/refresh_token=.*HttpOnly/i);
  });

  test('identifiants invalides : même réponse que le compte existe ou non', async () => {
    const p = await nouveauProprietaire();
    const inconnu = await api().post('/api/v1/auth/connexion').send({ identifiant: 'personne@test.sn', password: 'Faux12345' });
    const faux = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: 'Faux12345' });
    expect(inconnu.status).toBe(401);
    expect(faux.status).toBe(401);
    expect(inconnu.body.message).toBe(faux.body.message);
  });

  test('verrouillage après 5 échecs, même avec le bon mot de passe ensuite', async () => {
    const p = await nouveauProprietaire();
    for (let i = 0; i < 5; i += 1) {
      await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: 'Mauvais123' });
    }
    const res = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE });
    // Même réponse qu'un mot de passe faux (constat M4 : pas d'énumération par le blocage).
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('IDENTIFIANTS_INVALIDES');
  });

  test('refresh : rotation, et rejeu tardif d’un jeton consommé = toutes les sessions fermées', async () => {
    const p = await nouveauProprietaire();
    const r1 = await api().post('/api/v1/auth/refresh').send({ refresh_token: p.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.data.refresh_token).not.toBe(p.refreshToken);

    // Rejeu immédiat : refusé sans fermer les autres sessions (course légitime).
    const immediat = await api().post('/api/v1/auth/refresh').send({ refresh_token: p.refreshToken });
    expect(immediat.status).toBe(401);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: r1.body.data.refresh_token })).status).toBe(200);

    // Rejeu tardif (au-delà de la fenêtre de grâce) : vol présumé.
    await sequelize.query("UPDATE refresh_tokens SET revoked_at = now() - interval '1 hour' WHERE revoked_at IS NOT NULL AND user_id = :id", { replacements: { id: p.user.id } });
    const tardif = await api().post('/api/v1/auth/refresh').send({ refresh_token: p.refreshToken });
    expect(tardif.status).toBe(401);
    const [[{ actives }]] = await sequelize.query('SELECT count(*)::int AS actives FROM refresh_tokens WHERE user_id = :id AND revoked_at IS NULL', { replacements: { id: p.user.id } });
    expect(actives).toBe(0);
    // Le jeton d'accès émis avant est aussi périmé (token_version incrémenté).
    expect((await api().get('/api/v1/compte').set(p.h)).status).toBe(401);
  });

  test('changement de mot de passe : les autres sessions tombent, l’appareil courant reçoit une nouvelle session', async () => {
    const p = await nouveauProprietaire();
    const autre = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE });
    const res = await api().post('/api/v1/compte/mot-de-passe').set(p.h)
      .send({ current_password: MOT_DE_PASSE, password: 'NouveauMdp9', password_confirmation: 'NouveauMdp9' });
    expect(res.status).toBe(200);
    expect((await api().get('/api/v1/compte').set(bearer(autre.body.data.access_token))).status).toBe(401);
    expect((await api().get('/api/v1/compte').set(bearer(res.body.data.access_token))).status).toBe(200);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: autre.body.data.refresh_token })).status).toBe(401);
  });

  test('déconnexion distante d’une session précise', async () => {
    const p = await nouveauProprietaire();
    const autre = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE, device_name: 'Tablette' });
    const liste = await api().get('/api/v1/compte/sessions').set(p.h);
    const tablette = liste.body.data.sessions.find((s) => s.device_name === 'Tablette');
    expect((await api().delete(`/api/v1/compte/sessions/${tablette.id}`).set(p.h)).status).toBe(200);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: autre.body.data.refresh_token })).status).toBe(401);
  });

  test('jeton absent, falsifié ou refresh utilisé comme jeton d’accès : 401', async () => {
    const p = await nouveauProprietaire();
    expect((await api().get('/api/v1/compte')).status).toBe(401);
    expect((await api().get('/api/v1/compte').set(bearer(`${p.token}x`))).status).toBe(401);
    expect((await api().get('/api/v1/compte').set(bearer(p.refreshToken))).status).toBe(401);
  });

  test('compte désactivé : accès coupé à la requête suivante', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :id", { replacements: { id: p.user.id } });
    const res = await api().get('/api/v1/compte').set(p.h);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPTE_INACTIF');
  });

  test('mot de passe oublié : réponse identique, code à usage unique', async () => {
    const p = await nouveauProprietaire();
    const a = await api().post('/api/v1/auth/mot-de-passe-oublie').send({ identifiant: p.identifiants.email });
    const b = await api().post('/api/v1/auth/mot-de-passe-oublie').send({ identifiant: 'inconnu@test.sn' });
    expect(a.status).toBe(200);
    expect(b.body.message).toBe(a.body.message);
    const faux = await api().post('/api/v1/auth/reinitialiser-mot-de-passe')
      .send({ identifiant: p.identifiants.email, code: '000000', password: 'NouveauMdp9', password_confirmation: 'NouveauMdp9' });
    expect(faux.status).toBe(400);
  });
});
