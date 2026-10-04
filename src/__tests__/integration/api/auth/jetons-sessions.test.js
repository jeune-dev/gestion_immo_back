'use strict';

const jwt = require('jsonwebtoken');
const {
  api, bearer, MOT_DE_PASSE, nouveauProprietaire, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 5 « gestion de session », § 32 « tokens d'accès courts, refresh token
 * sécurisé, expiration de session, déconnexion distante » : toutes les façons
 * de présenter un jeton invalide, rotation et concurrence du refresh,
 * déconnexion.
 */

const COMPTE = '/api/v1/compte';
const REFRESH = '/api/v1/auth/refresh';
const DECONNEXION = '/api/v1/auth/deconnexion';

const signer = (charge, secret = process.env.JWT_SECRET, options = {}) => jwt.sign(charge, secret, { algorithm: 'HS256', ...options });

afterAll(fermer);

describe('Jeton d’accès : refus', () => {
  let p;
  beforeAll(async () => { p = await nouveauProprietaire(); });

  test('absent, sans préfixe Bearer, ou vide : 401 TOKEN_MANQUANT', async () => {
    for (const entete of [undefined, p.token, `Basic ${p.token}`, 'Bearer']) {
      const req = api().get(COMPTE);
      if (entete !== undefined) req.set('Authorization', entete);
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_MANQUANT');
    }
  });

  test('falsifié (signature altérée, autre secret, charge modifiée) : 401 TOKEN_INVALIDE', async () => {
    const [entete, charge] = p.token.split('.');
    const modifiee = Buffer.from(JSON.stringify({ ...jwt.decode(p.token), role: 'super_admin' })).toString('base64url');
    const jetons = [
      `${p.token.slice(0, -3)}abc`,
      signer({ sub: p.user.id, typ: 'access', tv: 0 }, 'un-autre-secret-de-plus-de-trente-deux-caracteres'),
      `${entete}.${modifiee}.${p.token.split('.')[2]}`,
      `${entete}.${charge}`,
      'nimporte.quoi.ici',
    ];
    for (const jeton of jetons) {
      const res = await api().get(COMPTE).set(bearer(jeton));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALIDE');
    }
  });

  test('algorithme « none » : 401', async () => {
    const sansSignature = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: p.user.id, typ: 'access', tv: 0 })).toString('base64url')}.`;
    expect((await api().get(COMPTE).set(bearer(sansSignature))).status).toBe(401);
  });

  test('expiré : 401 TOKEN_EXPIRE', async () => {
    const expire = signer({ sub: p.user.id, role: 'proprietaire', tv: 0, typ: 'access', exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await api().get(COMPTE).set(bearer(expire));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRE');
  });

  test('refresh token utilisé comme jeton d’accès, ou jeton sans type : 401', async () => {
    expect((await api().get(COMPTE).set(bearer(p.refreshToken))).status).toBe(401);
    // Même signé avec le bon secret, un jeton de type « refresh » est refusé.
    const refreshMalSigne = signer({ sub: p.user.id, typ: 'refresh', tv: 0 });
    const res = await api().get(COMPTE).set(bearer(refreshMalSigne));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALIDE');
    expect((await api().get(COMPTE).set(bearer(signer({ sub: p.user.id, tv: 0 })))).status).toBe(401);
  });

  test('utilisateur inexistant : 401 SESSION_INVALIDE', async () => {
    const res = await api().get(COMPTE).set(bearer(signer({ sub: '00000000-0000-4000-8000-000000000000', typ: 'access', tv: 0 }, undefined, { expiresIn: '5m' })));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_INVALIDE');
  });

  test('sans version de jeton : 401 SESSION_REVOQUEE', async () => {
    const res = await api().get(COMPTE).set(bearer(signer({ sub: p.user.id, typ: 'access' }, undefined, { expiresIn: '5m' })));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REVOQUEE');
  });
});

describe('Jeton d’accès : révocation par l’état du compte', () => {
  test('token_version incrémentée : 401 SESSION_REVOQUEE sur toutes les routes', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query('UPDATE users SET token_version = token_version + 1 WHERE id = :u', { replacements: { u: p.user.id } });
    for (const chemin of [COMPTE, '/api/v1/immeubles', '/api/v1/locataires', '/api/v1/parametres']) {
      const res = await api().get(chemin).set(p.h);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_REVOQUEE');
    }
  });

  test('compte désactivé : 403 COMPTE_INACTIF, réactivé : accès rétabli', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :u", { replacements: { u: p.user.id } });
    expect((await api().get('/api/v1/immeubles').set(p.h)).body.error.code).toBe('COMPTE_INACTIF');
    await sequelize.query("UPDATE users SET status = 'actif' WHERE id = :u", { replacements: { u: p.user.id } });
    expect((await api().get('/api/v1/immeubles').set(p.h)).status).toBe(200);
  });

  test('compte supprimé : 401', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query('UPDATE users SET deleted_at = now() WHERE id = :u', { replacements: { u: p.user.id } });
    const res = await api().get(COMPTE).set(p.h);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_INVALIDE');
  });

  test('compte verrouillé (anti force brute) : les sessions déjà ouvertes restent valides, une nouvelle connexion est refusée', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id = :u", { replacements: { u: p.user.id } });
    expect((await api().get(COMPTE).set(p.h)).status).toBe(200);
    const res = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('IDENTIFIANTS_INVALIDES');
  });
});

describe('Refresh', () => {
  test('rotation : nouveau couple, ancien refresh révoqué en base, appareil conservé', async () => {
    const p = await nouveauProprietaire();
    const connexion = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE, device_name: 'iPhone', platform: 'ios' });
    const res = await api().post(REFRESH).send({ refresh_token: connexion.body.data.refresh_token });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ access_token: expect.any(String), refresh_token: expect.any(String), user: { id: p.user.id } });
    expect(res.body.data.refresh_token).not.toBe(connexion.body.data.refresh_token);
    expect((await api().get(COMPTE).set(bearer(res.body.data.access_token))).status).toBe(200);
    expect(await compter('refresh_tokens', "user_id = :u AND device_name = 'iPhone' AND revoked_at IS NULL", { u: p.user.id })).toBe(1);
    expect(await compter('refresh_tokens', "user_id = :u AND device_name = 'iPhone' AND revoked_at IS NOT NULL", { u: p.user.id })).toBe(1);
  });

  test('absent : 401 SESSION_ABSENTE ; illisible, jeton d’accès, autre secret : 401 SESSION_INVALIDE', async () => {
    const p = await nouveauProprietaire();
    const absent = await api().post(REFRESH).send({});
    expect(absent.status).toBe(401);
    expect(absent.body.error.code).toBe('SESSION_ABSENTE');
    for (const jeton of ['nimporte-quoi', p.token, signer({ sub: p.user.id, typ: 'refresh' }, 'autre-secret-autre-secret-autre-secret')]) {
      const res = await api().post(REFRESH).send({ refresh_token: jeton });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_INVALIDE');
    }
  });

  test('refresh bien signé mais inconnu en base (jamais émis) : 401', async () => {
    const p = await nouveauProprietaire();
    const forge = signer({ sub: p.user.id, typ: 'refresh', jti: 'forge' }, process.env.JWT_REFRESH_SECRET, { expiresIn: '1d' });
    expect((await api().post(REFRESH).send({ refresh_token: forge })).status).toBe(401);
  });

  test('refresh d’un compte désactivé ou supprimé : 401', async () => {
    const a = await nouveauProprietaire();
    await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :u", { replacements: { u: a.user.id } });
    expect((await api().post(REFRESH).send({ refresh_token: a.refreshToken })).status).toBe(401);
    const b = await nouveauProprietaire();
    await sequelize.query('UPDATE users SET deleted_at = now() WHERE id = :u', { replacements: { u: b.user.id } });
    expect((await api().post(REFRESH).send({ refresh_token: b.refreshToken })).status).toBe(401);
  });

  test('refresh expiré en base : 401', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = :u", { replacements: { u: p.user.id } });
    expect((await api().post(REFRESH).send({ refresh_token: p.refreshToken })).status).toBe(401);
  });

  test('concurrence : 5 rafraîchissements simultanés du même jeton → au plus un succès, une seule session active', async () => {
    const p = await nouveauProprietaire();
    const reponses = await Promise.all(Array.from({ length: 5 }, () => api().post(REFRESH).send({ refresh_token: p.refreshToken })));
    const succes = reponses.filter((r) => r.status === 200);
    expect(succes.length).toBeLessThanOrEqual(1);
    expect(reponses.filter((r) => r.status === 401).length).toBe(5 - succes.length);
    expect(await compter('refresh_tokens', 'user_id = :u AND revoked_at IS NULL', { u: p.user.id })).toBe(succes.length);
  });

  test('client navigateur : refresh lu dans le cookie, nouveau cookie posé', async () => {
    const p = await nouveauProprietaire();
    const connexion = await api().post('/api/v1/auth/connexion').set('Origin', 'http://localhost:5173')
      .send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE });
    const cookie = connexion.headers['set-cookie'].find((c) => c.startsWith('refresh_token='));
    const res = await api().post(REFRESH).set('Origin', 'http://localhost:5173').set('Cookie', cookie.split(';')[0]).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.refresh_token).toBeUndefined();
    expect(res.headers['set-cookie'].join(';')).toMatch(/refresh_token=.*HttpOnly.*SameSite=Strict/i);
  });

  test('validation : refresh_token non textuel ou de plus de 2048 caractères → 422', async () => {
    expect((await api().post(REFRESH).send({ refresh_token: 12 })).status).toBe(422);
    expect((await api().post(REFRESH).send({ refresh_token: 'a'.repeat(2049) })).status).toBe(422);
  });
});

describe('Déconnexion', () => {
  test('ferme la session du refresh token : refresh refusé ensuite, les autres sessions restent', async () => {
    const p = await nouveauProprietaire();
    const autre = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE });
    const res = await api().post(DECONNEXION).send({ refresh_token: p.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: null });
    expect((await api().post(REFRESH).send({ refresh_token: p.refreshToken })).status).toBe(401);
    expect((await api().post(REFRESH).send({ refresh_token: autre.body.data.refresh_token })).status).toBe(200);
  });

  test('idempotente et sans jeton : 200, rien n’est révoqué', async () => {
    const p = await nouveauProprietaire();
    expect((await api().post(DECONNEXION).send({})).status).toBe(200);
    expect((await api().post(DECONNEXION).send({ refresh_token: 'inconnu' })).status).toBe(200);
    expect(await compter('refresh_tokens', 'user_id = :u AND revoked_at IS NULL', { u: p.user.id })).toBe(1);
    await api().post(DECONNEXION).send({ refresh_token: p.refreshToken });
    expect((await api().post(DECONNEXION).send({ refresh_token: p.refreshToken })).status).toBe(200);
  });

  test('client navigateur : cookie effacé', async () => {
    const res = await api().post(DECONNEXION).set('Origin', 'http://localhost:5173').send({});
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'].join(';')).toMatch(/refresh_token=;/);
  });
});

describe('CORRECTIFS sessions (audit de sécurité)', () => {
  const REFRESH = '/api/v1/auth/refresh';
  const rafraichir = (jeton) => api().post(REFRESH).send({ refresh_token: jeton });
  const sessionsActives = (u) => compter('refresh_tokens', 'user_id = :u AND revoked_at IS NULL', { u });

  test('vieux jeton DÉCONNECTÉ présenté plus tard : refusé, mais les autres sessions de la victime restent ouvertes', async () => {
    const p = await nouveauProprietaire();
    const autre = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE });
    expect((await api().post('/api/v1/auth/deconnexion').send({ refresh_token: p.refreshToken })).status).toBe(200);
    await sequelize.query("UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE user_id = :u AND revoked_reason = 'deconnexion'", { replacements: { u: p.user.id } });
    const [[{ token_version: avant }]] = await sequelize.query('SELECT token_version FROM users WHERE id = :u', { replacements: { u: p.user.id } });
    expect((await rafraichir(p.refreshToken)).status).toBe(401);
    expect(await sessionsActives(p.user.id)).toBe(1);
    const [[{ token_version: apres }]] = await sequelize.query('SELECT token_version FROM users WHERE id = :u', { replacements: { u: p.user.id } });
    expect(apres).toBe(avant);
    expect((await rafraichir(autre.body.data.refresh_token)).status).toBe(200);
  });

  test('jeton REMPLACÉ PAR ROTATION rejoué plus tard : vol présumé, toutes les sessions fermées (inchangé)', async () => {
    const p = await nouveauProprietaire();
    expect((await rafraichir(p.refreshToken)).status).toBe(200);
    await sequelize.query("UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE user_id = :u AND revoked_reason = 'rotation'", { replacements: { u: p.user.id } });
    expect((await rafraichir(p.refreshToken)).status).toBe(401);
    expect(await sessionsActives(p.user.id)).toBe(0);
    expect(await compter('refresh_tokens', "user_id = :u AND revoked_reason = 'rejeu'", { u: p.user.id })).toBeGreaterThanOrEqual(1);
  });

  test('durée maximale ABSOLUE : la rotation conserve le début de session ; au-delà de 90 jours, refus', async () => {
    const p = await nouveauProprietaire();
    const [[{ session_started_at: debut }]] = await sequelize.query('SELECT session_started_at FROM refresh_tokens WHERE user_id = :u', { replacements: { u: p.user.id } });
    const r1 = await rafraichir(p.refreshToken);
    expect(r1.status).toBe(200);
    const [[courante]] = await sequelize.query('SELECT session_started_at FROM refresh_tokens WHERE user_id = :u AND revoked_at IS NULL', { replacements: { u: p.user.id } });
    expect(new Date(courante.session_started_at).getTime()).toBe(new Date(debut).getTime());
    await sequelize.query("UPDATE refresh_tokens SET session_started_at = now() - interval '91 days' WHERE user_id = :u AND revoked_at IS NULL", { replacements: { u: p.user.id } });
    const r2 = await rafraichir(r1.body.data.refresh_token);
    expect(r2.status).toBe(401);
    expect(await compter('refresh_tokens', "user_id = :u AND revoked_reason = 'expiration'", { u: p.user.id })).toBe(1);
  });

  test('super admin : durée maximale de 12 heures', async () => {
    const { superAdmin } = require('../../../setup/helpers.js');
    const admin = await superAdmin();
    await sequelize.query("UPDATE refresh_tokens SET session_started_at = now() - interval '13 hours' WHERE user_id = :u AND revoked_at IS NULL", { replacements: { u: admin.user.id } });
    expect((await rafraichir(admin.refreshToken)).status).toBe(401);
  });

  test('chaque révocation porte son motif', async () => {
    const p = await nouveauProprietaire();
    const s2 = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE });
    const [[distante]] = await sequelize.query('SELECT id FROM refresh_tokens WHERE user_id = :u AND revoked_at IS NULL ORDER BY created_at ASC LIMIT 1', { replacements: { u: p.user.id } });
    expect((await api().delete(`/api/v1/compte/sessions/${distante.id}`).set(bearer(s2.body.data.access_token))).status).toBe(200);
    expect((await api().post('/api/v1/compte/sessions/revoquer-toutes').set(bearer(s2.body.data.access_token))).status).toBe(200);
    const [motifs] = await sequelize.query('SELECT revoked_reason FROM refresh_tokens WHERE user_id = :u ORDER BY created_at', { replacements: { u: p.user.id } });
    expect(motifs.map((m) => m.revoked_reason)).toEqual(['distante', 'globale']);
  });
});
