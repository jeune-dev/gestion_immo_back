'use strict';

const {
  api, bearer, MOT_DE_PASSE, nouveauProprietaire, superAdmin, codeTotp, emailUnique, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');
const totp = require('../../../../utils/totp.js');

/**
 * CORRECTIFS E1 / M3 de l'audit de sécurité — double authentification (TOTP)
 * OBLIGATOIRE pour le super admin, facultative pour les autres comptes ;
 * réinitialisation par e-mail fermée au super admin ; politique de mot de
 * passe renforcée maintenue ; ré-authentification des actions sensibles.
 */

const COMPTE = '/api/v1/compte';
const ADMIN = '/api/v1/admin';
const MDP_FORT = 'Zt7$pWq4!nBv';

const connexion = (identifiant, password = MOT_DE_PASSE) => api().post('/api/v1/auth/connexion').send({ identifiant, password });
const etapeCode = (corps) => api().post('/api/v1/auth/mfa').send(corps);
const ligneUser = async (id) => (await sequelize.query('SELECT * FROM users WHERE id = :id', { replacements: { id } }))[0][0];

/** Configure la double authentification d'un compte connecté ; renvoie secret, codes et nouveau jeton. */
async function configurerMfa(h, motDePasse = MOT_DE_PASSE) {
  const init = await api().post(`${COMPTE}/mfa/initialiser`).set(h).send({ current_password: motDePasse });
  expect(init.status).toBe(200);
  const active = await api().post(`${COMPTE}/mfa/activer`).set(h).send({ code: codeTotp(init.body.data.secret) });
  expect(active.status).toBe(200);
  return { secret: init.body.data.secret, codes: active.body.data.codes_secours, h: bearer(active.body.data.access_token) };
}

afterAll(fermer);

describe('Super admin : double authentification obligatoire', () => {
  test('sans double authentification : administration fermée (403 MFA_REQUISE), configuration seule ouverte', async () => {
    const admin = await superAdmin({ mfa: false });
    expect(admin.user.mfa_a_configurer).toBe(true);
    for (const url of [`${ADMIN}/dashboard`, `${ADMIN}/utilisateurs`, `${ADMIN}/parametres`]) {
      const res = await api().get(url).set(admin.h);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MFA_REQUISE');
    }
    expect((await api().get(COMPTE).set(admin.h)).status).toBe(200);
    // Configuration : mot de passe redemandé, puis code de confirmation.
    expect((await api().post(`${COMPTE}/mfa/initialiser`).set(admin.h).send({ current_password: 'faux' })).status).toBe(401);
    const init = await api().post(`${COMPTE}/mfa/initialiser`).set(admin.h).send({ current_password: MOT_DE_PASSE });
    expect(init.status).toBe(200);
    expect(init.body.data.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(init.body.data.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
    const faux = await api().post(`${COMPTE}/mfa/activer`).set(admin.h).send({ code: '000000' === codeTotp(init.body.data.secret) ? '111111' : '000000' });
    expect(faux.status).toBe(422);
    const active = await api().post(`${COMPTE}/mfa/activer`).set(admin.h).send({ code: codeTotp(init.body.data.secret) });
    expect(active.status).toBe(200);
    expect(active.body.data.codes_secours).toHaveLength(10);
    // Les sessions ouvertes SANS second facteur sont fermées.
    expect((await api().get(COMPTE).set(admin.h)).status).toBe(401);
    expect((await api().get(`${ADMIN}/dashboard`).set(bearer(active.body.data.access_token))).status).toBe(200);
    // Secret chiffré au repos, codes de secours en empreintes, jamais dans l'API.
    const ligne = await ligneUser(admin.user.id);
    expect(ligne.totp_secret).toMatch(/^v1:/);
    expect(ligne.totp_secret).not.toContain(init.body.data.secret);
    expect(ligne.mfa_recovery_codes).toHaveLength(10);
    expect(JSON.stringify(ligne.mfa_recovery_codes)).not.toContain(active.body.data.codes_secours[0].replace('-', ''));
    const profil = await api().get(COMPTE).set(bearer(active.body.data.access_token));
    expect(JSON.stringify(profil.body)).not.toMatch(/totp_secret|mfa_recovery_codes|totp_last_step/);
  });

  test('connexion : le mot de passe seul ne délivre AUCUNE session, seulement l’étape « code »', async () => {
    const admin = await superAdmin();
    const sessionsAvant = await compter('refresh_tokens', 'user_id = :u', { u: admin.user.id });
    const res = await connexion(admin.email);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mfa_requis: true, mfa_token: expect.any(String) });
    expect(res.body.data).not.toHaveProperty('access_token');
    expect(res.body.data).not.toHaveProperty('refresh_token');
    expect(await compter('refresh_tokens', 'user_id = :u', { u: admin.user.id })).toBe(sessionsAvant);
    // Le jeton intermédiaire n'est PAS un jeton d'accès.
    expect((await api().get(`${ADMIN}/dashboard`).set(bearer(res.body.data.mfa_token))).status).toBe(401);
    const ok = await etapeCode({ mfa_token: res.body.data.mfa_token, code: codeTotp(admin.secret, 1) });
    expect(ok.status).toBe(200);
    expect((await api().get(`${ADMIN}/dashboard`).set(bearer(ok.body.data.access_token))).status).toBe(200);
    expect(await compter('audit_logs', "action = 'compte.connexion_double_authentification' AND entity_id = :u", { u: admin.user.id })).toBe(2);
  });

  test('anti-rejeu : un code déjà utilisé est refusé, même encore valide', async () => {
    const admin = await superAdmin();
    const { mfa_token: jeton } = (await connexion(admin.email)).body.data;
    // Le code courant a servi à la connexion de superAdmin() : rejoué → refusé.
    const rejeu = await etapeCode({ mfa_token: jeton, code: codeTotp(admin.secret) });
    expect(rejeu.status).toBe(401);
    expect(rejeu.body.error.code).toBe('CODE_MFA_INVALIDE');
  });

  test('force brute : 5 codes faux verrouillent le compte, même le bon code est ensuite refusé', async () => {
    const admin = await superAdmin();
    const { mfa_token: jeton } = (await connexion(admin.email)).body.data;
    const bon = codeTotp(admin.secret, 1);
    const faux = (i) => String((Number(bon) + 1000 + i) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i += 1) expect((await etapeCode({ mfa_token: jeton, code: faux(i) })).status).toBe(401);
    expect((await ligneUser(admin.user.id)).locked_until).not.toBeNull();
    expect((await etapeCode({ mfa_token: jeton, code: bon })).status).toBe(401);
    // Se reconnecter par mot de passe ne remet PAS le compteur à zéro (pas de contournement).
    expect((await connexion(admin.email)).status).toBe(401);
  });

  test('10 codes faux simultanés : jamais plus que le plafond d’essais', async () => {
    const admin = await superAdmin();
    const { mfa_token: jeton } = (await connexion(admin.email)).body.data;
    const bon = codeTotp(admin.secret, 1);
    await Promise.all(Array.from({ length: 10 }, (_, i) => etapeCode({ mfa_token: jeton, code: String((Number(bon) + 7 + i) % 1_000_000).padStart(6, '0') })));
    expect((await etapeCode({ mfa_token: jeton, code: bon })).status).toBe(401);
  });

  test('jeton intermédiaire falsifié, d’un autre type ou périmé (session révoquée) → 401 JETON_MFA_INVALIDE', async () => {
    const admin = await superAdmin();
    const { mfa_token: jeton } = (await connexion(admin.email)).body.data;
    for (const mauvais of ['pas.un.jeton', admin.token, admin.refreshToken, `${jeton}x`]) {
      const res = await etapeCode({ mfa_token: mauvais, code: codeTotp(admin.secret, 1) });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('JETON_MFA_INVALIDE');
    }
    await sequelize.query('UPDATE users SET token_version = token_version + 1 WHERE id = :u', { replacements: { u: admin.user.id } });
    expect((await etapeCode({ mfa_token: jeton, code: codeTotp(admin.secret, 1) })).body.error.code).toBe('JETON_MFA_INVALIDE');
  });

  test('code de secours : accepté une seule fois', async () => {
    const admin = await superAdmin({ mfa: false });
    const { codes } = await configurerMfa(admin.h);
    const { mfa_token: j1 } = (await connexion(admin.email)).body.data;
    const ok = await etapeCode({ mfa_token: j1, code_secours: codes[0].toLowerCase() });
    expect(ok.status).toBe(200);
    expect((await ligneUser(admin.user.id)).mfa_recovery_codes).toHaveLength(9);
    const { mfa_token: j2 } = (await connexion(admin.email)).body.data;
    expect((await etapeCode({ mfa_token: j2, code_secours: codes[0] })).status).toBe(401);
    expect((await etapeCode({ mfa_token: j2, code_secours: codes[1] })).status).toBe(200);
  });

  test('désactivation impossible pour un super admin (403 MFA_OBLIGATOIRE)', async () => {
    const admin = await superAdmin();
    const res = await api().post(`${COMPTE}/mfa/desactiver`).set(admin.h).send({ current_password: MOT_DE_PASSE, code: codeTotp(admin.secret, 1) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_OBLIGATOIRE');
    expect((await ligneUser(admin.user.id)).totp_enabled_at).not.toBeNull();
  });

  test('mot de passe oublié : aucune réinitialisation par e-mail pour un super admin (réponse identique)', async () => {
    const admin = await superAdmin();
    const p = await nouveauProprietaire();
    const pourAdmin = await api().post('/api/v1/auth/mot-de-passe-oublie').send({ identifiant: admin.email });
    const pourProprio = await api().post('/api/v1/auth/mot-de-passe-oublie').send({ identifiant: p.identifiants.email });
    expect(pourAdmin.status).toBe(pourProprio.status);
    expect(pourAdmin.body.message).toBe(pourProprio.body.message);
    expect(await compter('password_resets', 'user_id = :u', { u: admin.user.id })).toBe(0);
    expect(await compter('password_resets', 'user_id = :u', { u: p.user.id })).toBe(1);
    expect(await compter('audit_logs', "action = 'compte.reinitialisation_refusee' AND entity_id = :u", { u: admin.user.id })).toBe(1);
    // Même avec une demande forgée en base, la réinitialisation est refusée.
    const res = await api().post('/api/v1/auth/reinitialiser-mot-de-passe')
      .send({ identifiant: admin.email, code: '123456', password: MDP_FORT, password_confirmation: MDP_FORT });
    expect(res.status).toBe(400);
  });

  test('changement de mot de passe : politique renforcée maintenue, identique refusé', async () => {
    const admin = await superAdmin();
    const changer = (password) => api().post(`${COMPTE}/mot-de-passe`).set(admin.h)
      .send({ current_password: MOT_DE_PASSE, password, password_confirmation: password });
    const faible = await changer('Password123');
    expect(faible.status).toBe(422);
    expect(faible.body.error.code).toBe('MOT_DE_PASSE_TROP_FAIBLE');
    const identique = await changer(MOT_DE_PASSE);
    expect(identique.status).toBe(422);
    expect(identique.body.error.code).toBe('MOT_DE_PASSE_IDENTIQUE');
    expect((await changer(MDP_FORT)).status).toBe(200);
  });

  test('création d’un super admin : mot de passe de l’administrateur exigé', async () => {
    const admin = await superAdmin();
    const corps = { first_name: 'Awa', last_name: 'Sow', email: emailUnique('adm'), password: 'Xk9#vLq2!mRt' };
    expect((await api().post(`${ADMIN}/utilisateurs`).set(admin.h).send(corps)).status).toBe(422);
    const faux = await api().post(`${ADMIN}/utilisateurs`).set(admin.h).send({ ...corps, current_password: 'Faux123456' });
    expect(faux.status).toBe(401);
    expect(await compter('users', 'lower(email) = :e', { e: corps.email })).toBe(0);
    expect((await api().post(`${ADMIN}/utilisateurs`).set(admin.h).send({ ...corps, current_password: MOT_DE_PASSE })).status).toBe(201);
  });

  test('rétablissement d’accès par un autre super admin : provisoire, double authentification à refaire, sessions fermées', async () => {
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
    expect((await api().get(COMPTE).set(cible.h)).status).toBe(401);
    const ligne = await ligneUser(cible.user.id);
    expect(ligne).toMatchObject({ must_change_password: true, totp_enabled_at: null, totp_secret: null });
    // Nouvelle connexion : mot de passe provisoire → changement → configuration MFA.
    const c = await connexion(cible.email, provisoire);
    expect(c.status).toBe(200);
    expect(c.body.data.user.must_change_password).toBe(true);
    expect(await compter('audit_logs', "action = 'utilisateur.reinitialisation_acces' AND entity_id = :u", { u: cible.user.id })).toBe(1);
    // Un propriétaire n'a pas accès à cette route.
    const p = await nouveauProprietaire();
    expect((await api().post(url).set(p.h).send({ current_password: MOT_DE_PASSE, reason: 'x y z' })).status).toBe(403);
  });
});

describe('Double authentification facultative (propriétaire)', () => {
  test('activation, connexion en deux étapes, désactivation avec mot de passe + code (déjà utilisé : refusé)', async () => {
    const p = await nouveauProprietaire();
    const { secret, codes, h } = await configurerMfa(p.h);
    const c = await connexion(p.identifiants.email);
    expect(c.body.data.mfa_requis).toBe(true);
    const ok = await etapeCode({ mfa_token: c.body.data.mfa_token, code: codeTotp(secret, 1) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.mfa_active).toBe(true);
    const sansCode = await api().post(`${COMPTE}/mfa/desactiver`).set(h).send({ current_password: MOT_DE_PASSE });
    expect(sansCode.status).toBe(422);
    // Les pas courant (activation) et suivant (connexion) sont consommés : un
    // code d'un pas antérieur est refusé (anti-rejeu) — le code de secours passe.
    const rejeu = await api().post(`${COMPTE}/mfa/desactiver`).set(h).send({ current_password: MOT_DE_PASSE, code: codeTotp(secret, -1) });
    expect(rejeu.status).toBe(401);
    const res = await api().post(`${COMPTE}/mfa/desactiver`).set(h).send({ current_password: MOT_DE_PASSE, code_secours: codes[0] });
    expect(res.status).toBe(200);
    expect((await connexion(p.identifiants.email)).body.data.access_token).toEqual(expect.any(String));
  });

  test('régénération des codes de secours : les anciens deviennent invalides', async () => {
    const p = await nouveauProprietaire();
    const { secret, codes, h } = await configurerMfa(p.h);
    const regen = await api().post(`${COMPTE}/mfa/codes-secours`).set(h).send({ current_password: MOT_DE_PASSE, code: codeTotp(secret, 1) });
    expect(regen.status).toBe(200);
    expect(regen.body.data.codes_secours).toHaveLength(10);
    const { mfa_token: jeton } = (await connexion(p.identifiants.email)).body.data;
    expect((await etapeCode({ mfa_token: jeton, code_secours: codes[0] })).status).toBe(401);
    expect((await etapeCode({ mfa_token: jeton, code_secours: regen.body.data.codes_secours[0] })).status).toBe(200);
  });

  test('double authentification déjà active → 409 ; activation sans initialisation → 409', async () => {
    const p = await nouveauProprietaire();
    expect((await api().post(`${COMPTE}/mfa/activer`).set(p.h).send({ code: '123456' })).status).toBe(409);
    const { h } = await configurerMfa(p.h);
    expect((await api().post(`${COMPTE}/mfa/initialiser`).set(h).send({ current_password: MOT_DE_PASSE })).status).toBe(409);
  });

  test('validation : code non numérique, code ET code de secours, champs manquants → 422', async () => {
    const res = await Promise.all([
      etapeCode({ mfa_token: 'x', code: 'abcdef' }),
      etapeCode({ mfa_token: 'x', code: '123456', code_secours: 'AAAA-BBBB' }),
      etapeCode({ code: '123456' }),
      etapeCode({ mfa_token: 'x' }),
    ]);
    for (const r of res) expect(r.status).toBe(422);
    expect(totp.PAS_S).toBe(30);
  });
});
