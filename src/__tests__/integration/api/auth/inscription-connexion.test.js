'use strict';

const {
  api, MOT_DE_PASSE, nouveauProprietaire, telephoneUnique, emailUnique, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');
const sessions = require('../../../../modules/auth/service/session.service.js');

/**
 * § 5 Inscription / connexion — parcours nominal, validation exhaustive,
 * élévation de privilège, atomicité (§ 32) et concurrence.
 */

const INSCRIPTION = '/api/v1/auth/inscription';
const CONNEXION = '/api/v1/auth/connexion';

const corpsInscription = (surcharges = {}) => ({
  first_name: 'Awa', last_name: 'Fall', phone: telephoneUnique(), email: emailUnique('inscription'),
  password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE, ...surcharges,
});

const connecter = (identifiant, password = MOT_DE_PASSE) => api().post(CONNEXION).send({ identifiant, password });

afterAll(fermer);

describe('Auth — inscription', () => {
  test('nominal : 201, session, compte + espace + appartenance + essai + audit + refresh token en base', async () => {
    const corps = corpsInscription({ company_name: 'SCI Fall', city: 'Thiès' });
    const res = await api().post(INSCRIPTION).send(corps);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Compte propriétaire créé' });
    const d = res.body.data;
    expect(d).toMatchObject({ token_type: 'Bearer', expires_in: expect.any(String), access_token: expect.any(String), refresh_token: expect.any(String) });
    expect(d.user).toEqual({
      id: expect.any(String), role: 'proprietaire', first_name: 'Awa', last_name: 'Fall', email: corps.email,
      phone: corps.phone, status: 'actif', language: 'fr', must_change_password: false,
      mfa_active: false, mfa_a_configurer: false,
    });

    const [[owner]] = await sequelize.query('SELECT o.* FROM owners o JOIN owner_members m ON m.owner_id = o.id WHERE m.user_id = :u', { replacements: { u: d.user.id } });
    expect(owner).toMatchObject({ display_name: 'Awa Fall', company_name: 'SCI Fall', city: 'Thiès', status: 'actif', user_id: d.user.id });
    expect(await compter('owner_members', "user_id = :u AND role_code = 'proprietaire' AND status = 'actif'", { u: d.user.id })).toBe(1);
    const [[abo]] = await sequelize.query('SELECT s.status, p.code, s.current_period_end - s.current_period_start AS jours FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.owner_id = :o', { replacements: { o: owner.id } });
    expect(abo).toMatchObject({ status: 'essai', code: 'BUSINESS', jours: 14 });
    expect(await compter('audit_logs', "action = 'compte.creation' AND entity_id = :u AND owner_id = :o", { u: d.user.id, o: owner.id })).toBe(1);
    expect(await compter('refresh_tokens', 'user_id = :u AND revoked_at IS NULL', { u: d.user.id })).toBe(1);
    const [[u]] = await sequelize.query('SELECT password_hash FROM users WHERE id = :u', { replacements: { u: d.user.id } });
    expect(u.password_hash).not.toBe(MOT_DE_PASSE);
    expect(u.password_hash).toMatch(/^\$2[aby]\$/);
  });

  test('téléphone national et e-mail en majuscules : normalisés (E.164, minuscules)', async () => {
    const tel = telephoneUnique();
    const email = emailUnique('MAJ').toUpperCase();
    const res = await api().post(INSCRIPTION).send(corpsInscription({ phone: `${tel.slice(4, 6)} ${tel.slice(6, 9)} ${tel.slice(9, 11)} ${tel.slice(11)}`, email }));
    expect(res.status).toBe(201);
    expect(res.body.data.user.phone).toBe(tel);
    expect(res.body.data.user.email).toBe(email.toLowerCase());
  });

  test('élévation de privilège : role_code, status, owner_id, permissions, token_version envoyés sont ignorés', async () => {
    const res = await api().post(INSCRIPTION).send(corpsInscription({
      role_code: 'super_admin', role: 'super_admin', status: 'inactif', owner_id: '00000000-0000-4000-8000-000000000000',
      permissions: ['admin.dashboard'], token_version: 99, must_change_password: true, email_verified_at: '2020-01-01',
    }));
    expect(res.status).toBe(201);
    const [[u]] = await sequelize.query('SELECT role_code, status, token_version, must_change_password, email_verified_at FROM users WHERE id = :id', { replacements: { id: res.body.data.user.id } });
    expect(u).toEqual({ role_code: 'proprietaire', status: 'actif', token_version: 0, must_change_password: false, email_verified_at: null });
    const h = { Authorization: `Bearer ${res.body.data.access_token}` };
    expect((await api().get('/api/v1/admin/dashboard').set(h)).status).toBe(403);
  });

  test.each([
    ['prénom manquant', { first_name: undefined }],
    ['nom manquant', { last_name: undefined }],
    ['téléphone manquant', { phone: undefined }],
    ['e-mail manquant', { email: undefined }],
    ['mot de passe manquant', { password: undefined }],
    ['confirmation manquante', { password_confirmation: undefined }],
    ['prénom vide', { first_name: '   ' }],
    ['prénom de 81 caractères', { first_name: 'a'.repeat(81) }],
    ['nom non textuel', { last_name: 12345 }],
    ['e-mail invalide', { email: 'pas-un-email' }],
    ['e-mail de 255 caractères', { email: `${'a'.repeat(245)}@test.sn` }],
    ['téléphone invalide', { phone: 'abc' }],
    ['téléphone trop court', { phone: '+2211' }],
    ['téléphone trop long', { phone: '+2217712345678901234' }],
    ['mot de passe sans majuscule', { password: 'motdepasse1', password_confirmation: 'motdepasse1' }],
    ['mot de passe sans chiffre', { password: 'MotDePasse', password_confirmation: 'MotDePasse' }],
    ['mot de passe de 7 caractères', { password: 'Mdp1234', password_confirmation: 'Mdp1234' }],
    ['mot de passe de 129 caractères', { password: `Aa1${'x'.repeat(126)}`, password_confirmation: `Aa1${'x'.repeat(126)}` }],
    ['confirmation différente', { password_confirmation: 'Autre12345' }],
    ['raison sociale de 151 caractères', { company_name: 'x'.repeat(151) }],
    ['ville de 101 caractères', { city: 'x'.repeat(101) }],
  ])('validation 422 : %s — aucune ligne créée', async (_libelle, surcharge) => {
    const corps = corpsInscription(surcharge);
    for (const [cle, valeur] of Object.entries(surcharge)) if (valeur === undefined) delete corps[cle];
    const avant = await compter('users');
    const res = await api().post(INSCRIPTION).send(corps);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ success: false, error: { code: 'DONNEES_INVALIDES', details: expect.any(Array) } });
    expect(await compter('users')).toBe(avant);
  });

  test('corps vide : 422 listant tous les champs obligatoires', async () => {
    const res = await api().post(INSCRIPTION).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(6);
  });

  test('JSON malformé : 400 JSON_INVALIDE', async () => {
    const res = await api().post(INSCRIPTION).set('Content-Type', 'application/json').send('{"first_name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('JSON_INVALIDE');
  });

  test('doublons : même e-mail (casse différente) ou même téléphone (format national) → 409 COMPTE_EXISTANT', async () => {
    const p = await nouveauProprietaire();
    const parEmail = await api().post(INSCRIPTION).send(corpsInscription({ email: p.identifiants.email.toUpperCase() }));
    expect(parEmail.status).toBe(409);
    expect(parEmail.body.error.code).toBe('COMPTE_EXISTANT');
    const parTel = await api().post(INSCRIPTION).send(corpsInscription({ phone: p.identifiants.phone.replace('+221', '') }));
    expect(parTel.status).toBe(409);
    expect(parTel.body.error.message).toMatch(/téléphone/);
  });

  test('atomicité (§ 32) : échec à l’ouverture de session → ni compte, ni espace, ni appartenance, ni abonnement, ni audit', async () => {
    const corps = corpsInscription();
    const espion = jest.spyOn(sessions, 'ouvrirSession').mockRejectedValueOnce(new Error('panne simulée'));
    try {
      const res = await api().post(INSCRIPTION).send(corps);
      expect(res.status).toBe(500);
    } finally {
      espion.mockRestore();
    }
    expect(await compter('users', 'lower(email) = :e OR phone = :p', { e: corps.email, p: corps.phone })).toBe(0);
    expect(await compter('owners', 'lower(email) = :e OR phone = :p', { e: corps.email, p: corps.phone })).toBe(0);
    expect(await compter('owner_members m JOIN owners o ON o.id = m.owner_id', 'o.phone = :p', { p: corps.phone })).toBe(0);
    expect(await compter('subscriptions s JOIN owners o ON o.id = s.owner_id', 'o.phone = :p', { p: corps.phone })).toBe(0);
    expect(await compter('audit_logs', "action = 'compte.creation' AND details->>'role' = 'proprietaire' AND created_at > now() - interval '5 seconds' AND entity_id NOT IN (SELECT id::text FROM users)")).toBe(0);
    // Le même formulaire réussit ensuite : rien de résiduel ne bloque.
    expect((await api().post(INSCRIPTION).send(corps)).status).toBe(201);
  });

  test('concurrence : deux inscriptions simultanées avec le même e-mail → exactement un compte', async () => {
    const email = emailUnique('course');
    const reponses = await Promise.all([
      api().post(INSCRIPTION).send(corpsInscription({ email })),
      api().post(INSCRIPTION).send(corpsInscription({ email })),
      api().post(INSCRIPTION).send(corpsInscription({ email })),
    ]);
    const statuts = reponses.map((r) => r.status).sort();
    expect(statuts).toEqual([201, 409, 409]);
    expect(await compter('users', 'lower(email) = :e', { e: email })).toBe(1);
    expect(await compter('owners', 'lower(email) = :e', { e: email })).toBe(1);
  });

  test('concurrence : deux inscriptions simultanées avec le même téléphone → exactement un compte', async () => {
    const phone = telephoneUnique();
    const reponses = await Promise.all([
      api().post(INSCRIPTION).send(corpsInscription({ phone })),
      api().post(INSCRIPTION).send(corpsInscription({ phone })),
    ]);
    expect(reponses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await compter('users', 'phone = :p', { p: phone })).toBe(1);
    expect(await compter('owners', 'phone = :p', { p: phone })).toBe(1);
  });
});

describe('Auth — connexion', () => {
  test('par e-mail (casse libre) et par téléphone (national, international, 00) : 200 et session enregistrée', async () => {
    const p = await nouveauProprietaire();
    for (const identifiant of [p.identifiants.email.toUpperCase(), p.identifiants.phone, p.identifiants.phone.replace('+', '00'), p.identifiants.phone.replace('+221', '')]) {
      const res = await connecter(identifiant);
      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ id: p.user.id, role: 'proprietaire' });
    }
    expect(await compter('refresh_tokens', 'user_id = :u AND revoked_at IS NULL', { u: p.user.id })).toBe(5);
    const [[u]] = await sequelize.query('SELECT last_login_at FROM users WHERE id = :u', { replacements: { u: p.user.id } });
    expect(u.last_login_at).not.toBeNull();
  });

  test('nom d’appareil et plateforme enregistrés sur la session', async () => {
    const p = await nouveauProprietaire();
    const res = await api().post(CONNEXION).send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE, device_name: 'Galaxy A54', platform: 'android' });
    expect(res.status).toBe(200);
    expect(await compter('refresh_tokens', "user_id = :u AND device_name = 'Galaxy A54' AND platform = 'android'", { u: p.user.id })).toBe(1);
  });

  test.each([
    ['identifiant manquant', { password: MOT_DE_PASSE }],
    ['mot de passe manquant', { identifiant: 'x@test.sn' }],
    ['identifiant de 255 caractères', { identifiant: `${'a'.repeat(250)}@t.sn`, password: MOT_DE_PASSE }],
    ['mot de passe de 129 caractères', { identifiant: 'x@test.sn', password: 'a'.repeat(129) }],
    ['plateforme inconnue', { identifiant: 'x@test.sn', password: MOT_DE_PASSE, platform: 'windows' }],
    ['identifiant non textuel', { identifiant: { $ne: null }, password: MOT_DE_PASSE }],
  ])('validation 422 : %s', async (_l, corps) => {
    const res = await api().post(CONNEXION).send(corps);
    expect(res.status).toBe(422);
  });

  test('identifiant inexploitable (ni e-mail, ni téléphone) : 401 générique', async () => {
    const res = await connecter('pas un identifiant');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('IDENTIFIANTS_INVALIDES');
  });

  test('injection SQL dans l’identifiant : 401, table intacte', async () => {
    const avant = await compter('users');
    for (const identifiant of ["' OR 1=1 --", "admin'--@test.sn", "'; DROP TABLE users; --"]) {
      const res = await connecter(identifiant, "' OR '1'='1");
      expect(res.status).toBe(401);
    }
    expect(await compter('users')).toBe(avant);
  });

  test('échec : compteur incrémenté puis remis à zéro par une connexion réussie', async () => {
    const p = await nouveauProprietaire();
    await connecter(p.identifiants.email, 'Mauvais123');
    await connecter(p.identifiants.email, 'Mauvais123');
    const [[avant]] = await sequelize.query('SELECT failed_login_attempts FROM users WHERE id = :u', { replacements: { u: p.user.id } });
    expect(avant.failed_login_attempts).toBe(2);
    expect((await connecter(p.identifiants.email)).status).toBe(200);
    const [[apres]] = await sequelize.query('SELECT failed_login_attempts, locked_until FROM users WHERE id = :u', { replacements: { u: p.user.id } });
    expect(apres).toEqual({ failed_login_attempts: 0, locked_until: null });
  });

  test('verrouillage : 5 échecs → bloqué, audit, levé après expiration ; CORRECTIF M4 : réponse identique à un mot de passe faux', async () => {
    const p = await nouveauProprietaire();
    for (let i = 0; i < 5; i += 1) expect((await connecter(p.identifiants.email, 'Mauvais123')).status).toBe(401);
    const faux = await connecter(p.identifiants.email, 'Mauvais123');
    const bloque = await connecter(p.identifiants.email);
    expect(bloque.status).toBe(401);
    expect(bloque.body.error.code).toBe('IDENTIFIANTS_INVALIDES');
    // Rien ne distingue « bloqué » de « mot de passe faux » ni de « compte inconnu ».
    const inconnu = await connecter(`inconnu.${Date.now()}@test.sn`);
    for (const r of [faux, inconnu]) {
      expect(r.status).toBe(bloque.status);
      expect(r.body.message).toBe(bloque.body.message);
      expect(r.body.error.code).toBe(bloque.body.error.code);
      expect(r.body.error).not.toHaveProperty('details');
    }
    expect(await compter('audit_logs', "action = 'compte.verrouillage' AND entity_id = :u", { u: p.user.id })).toBe(1);
    // Expiration du blocage : la connexion redevient possible.
    await sequelize.query("UPDATE users SET locked_until = now() - interval '1 minute' WHERE id = :u", { replacements: { u: p.user.id } });
    expect((await connecter(p.identifiants.email)).status).toBe(200);
  });

  test('verrouillage : 5 échecs SIMULTANÉS comptent tous (incrément atomique)', async () => {
    const p = await nouveauProprietaire();
    await Promise.all(Array.from({ length: 5 }, () => connecter(p.identifiants.email, 'Mauvais123')));
    // Bloqué : même le bon mot de passe est refusé (réponse générique).
    expect((await connecter(p.identifiants.email)).body.error.code).toBe('IDENTIFIANTS_INVALIDES');
    expect((await sequelize.query('SELECT locked_until FROM users WHERE id = :u', { replacements: { u: p.user.id } }))[0][0].locked_until).not.toBeNull();
  });

  test('compte désactivé : 403 COMPTE_INACTIF seulement avec le bon mot de passe (anti-énumération)', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :u", { replacements: { u: p.user.id } });
    expect((await connecter(p.identifiants.email, 'Mauvais123')).status).toBe(401);
    const res = await connecter(p.identifiants.email);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPTE_INACTIF');
  });

  test('compte supprimé (logiquement) : 401 comme un compte inconnu', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query('UPDATE users SET deleted_at = now() WHERE id = :u', { replacements: { u: p.user.id } });
    const res = await connecter(p.identifiants.email);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('IDENTIFIANTS_INVALIDES');
  });

  test('réponse de connexion : aucun secret (empreinte, version de jeton, compteur)', async () => {
    const p = await nouveauProprietaire();
    const res = await connecter(p.identifiants.email);
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|token_version|failed_login_attempts|locked_until/);
  });
});
