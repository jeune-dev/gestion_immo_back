'use strict';

const {
  api, bearer, MOT_DE_PASSE, nouveauProprietaire, superAdmin, codeTotp, proprietaireEtLocataire, emailUnique, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');
const email = require('../../../../infrastructure/email.service.js');

/**
 * § 5 et § 32 — compte de l'utilisateur connecté : profil, changement de
 * mot de passe, mot de passe provisoire, sessions et déconnexion distante,
 * appareils push.
 */

const COMPTE = '/api/v1/compte';
const NOUVEAU = 'NouveauMdp9';

afterAll(fermer);

const changerMdp = (h, actuel = MOT_DE_PASSE, nouveau = NOUVEAU) => api().post(`${COMPTE}/mot-de-passe`).set(h)
  .send({ current_password: actuel, password: nouveau, password_confirmation: nouveau });

describe('GET /compte', () => {
  test('propriétaire : utilisateur, espace et état de l’abonnement ; aucun secret', async () => {
    const p = await nouveauProprietaire();
    const res = await api().get(COMPTE).set(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: p.user.id, role_code: 'proprietaire', email: p.identifiants.email, must_change_password: false });
    expect(res.body.data.owner).toMatchObject({ id: p.ownerId, status: 'actif' });
    expect(res.body.data.abonnement).toMatchObject({ actif: true, abonnement: { status: 'essai' }, plan: { code: 'BUSINESS' } });
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|token_version|failed_login_attempts|locked_until/);
  });

  test('locataire et super admin : utilisateur seul (pas d’espace propriétaire)', async () => {
    const { locataire } = await proprietaireEtLocataire();
    const admin = await superAdmin();
    for (const h of [locataire.h, admin.h]) {
      const res = await api().get(COMPTE).set(h);
      expect(res.status).toBe(200);
      expect(res.body.data.owner).toBeUndefined();
      expect(res.body.data.abonnement).toBeUndefined();
    }
  });

  test('sans jeton : 401', async () => {
    expect((await api().get(COMPTE)).status).toBe(401);
  });
});

describe('PATCH /compte', () => {
  test('nom, prénom, langue : modifiés et journalisés', async () => {
    const p = await nouveauProprietaire();
    const res = await api().patch(COMPTE).set(p.h).send({ first_name: 'Moussa', language: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ first_name: 'Moussa', language: 'en' });
    const [[audit]] = await sequelize.query("SELECT details, user_id FROM audit_logs WHERE action = 'compte.modification' AND entity_id = :u", { replacements: { u: p.user.id } });
    expect(audit.user_id).toBe(p.user.id);
    expect(audit.details.first_name).toEqual({ avant: 'Balla', apres: 'Moussa' });
  });

  test('CORRECTIF prise de contrôle : changer l’e-mail sans mot de passe actuel → 422, sans modification', async () => {
    const p = await nouveauProprietaire();
    const res = await api().patch(COMPTE).set(p.h).send({ email: emailUnique('pirate') });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MOT_DE_PASSE_ACTUEL_REQUIS');
    const [[u]] = await sequelize.query('SELECT email FROM users WHERE id = :u', { replacements: { u: p.user.id } });
    expect(u.email).toBe(p.identifiants.email);
  });

  test('CORRECTIF : mot de passe actuel faux → 401 MOT_DE_PASSE_INCORRECT, e-mail inchangé', async () => {
    const p = await nouveauProprietaire();
    const res = await api().patch(COMPTE).set(p.h).send({ email: emailUnique('pirate'), current_password: 'Devine123' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MOT_DE_PASSE_INCORRECT');
    const [[u]] = await sequelize.query('SELECT email FROM users WHERE id = :u', { replacements: { u: p.user.id } });
    expect(u.email).toBe(p.identifiants.email);
  });

  test('CORRECTIF : avec le bon mot de passe → e-mail changé, non vérifié, changement journalisé ; l’ancien e-mail ne reçoit plus de code', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query('UPDATE users SET email_verified_at = now() WHERE id = :u', { replacements: { u: p.user.id } });
    const nouvelEmail = emailUnique('nouveau');
    const res = await api().patch(COMPTE).set(p.h).send({ email: nouvelEmail.toUpperCase(), current_password: MOT_DE_PASSE });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email: nouvelEmail, email_verified_at: null });
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|current_password/);
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'compte.changement_email' AND entity_id = :u", { replacements: { u: p.user.id } });
    expect(audit.details).toEqual({ avant: p.identifiants.email, apres: nouvelEmail });

    const envoi = jest.spyOn(email, 'envoyerCodeReinitialisation').mockResolvedValue({ envoye: true });
    try {
      await api().post('/api/v1/auth/mot-de-passe-oublie').send({ identifiant: p.identifiants.email });
      expect(envoi).not.toHaveBeenCalled();
      await api().post('/api/v1/auth/mot-de-passe-oublie').send({ identifiant: nouvelEmail });
      expect(envoi).toHaveBeenCalledTimes(1);
    } finally {
      envoi.mockRestore();
    }
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: nouvelEmail, password: MOT_DE_PASSE })).status).toBe(200);
  });

  test('retirer l’e-mail (null) exige aussi le mot de passe', async () => {
    const p = await nouveauProprietaire();
    expect((await api().patch(COMPTE).set(p.h).send({ email: null })).status).toBe(422);
    const res = await api().patch(COMPTE).set(p.h).send({ email: null, current_password: MOT_DE_PASSE });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBeNull();
  });

  test('e-mail identique (autre casse) : pas un changement, mot de passe non exigé', async () => {
    const p = await nouveauProprietaire();
    const res = await api().patch(COMPTE).set(p.h).send({ email: p.identifiants.email.toUpperCase(), first_name: 'Ibrahima' });
    expect(res.status).toBe(200);
    expect(await compter('audit_logs', "action = 'compte.changement_email' AND entity_id = :u", { u: p.user.id })).toBe(0);
  });

  test('e-mail déjà utilisé par un autre compte : 409 EMAIL_UTILISE', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const res = await api().patch(COMPTE).set(a.h).send({ email: b.identifiants.email, current_password: MOT_DE_PASSE });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_UTILISE');
  });

  test('élévation : role_code, status, password_hash, must_change_password, token_version ignorés', async () => {
    const p = await nouveauProprietaire();
    const res = await api().patch(COMPTE).set(p.h).send({
      first_name: 'Test', role_code: 'super_admin', status: 'inactif', password_hash: 'x', must_change_password: true, token_version: 50, phone: '+221700000000',
    });
    expect(res.status).toBe(200);
    const [[u]] = await sequelize.query('SELECT role_code, status, must_change_password, token_version, phone FROM users WHERE id = :u', { replacements: { u: p.user.id } });
    expect(u).toEqual({ role_code: 'proprietaire', status: 'actif', must_change_password: false, token_version: 0, phone: p.identifiants.phone });
    expect((await api().get(COMPTE).set(p.h)).status).toBe(200);
  });

  test.each([
    ['corps vide', {}],
    ['mot de passe actuel seul', { current_password: MOT_DE_PASSE }],
    ['prénom de 81 caractères', { first_name: 'a'.repeat(81) }],
    ['prénom vide', { first_name: '' }],
    ['langue inconnue', { language: 'de' }],
    ['e-mail invalide', { email: 'pas-un-email', current_password: MOT_DE_PASSE }],
    ['nom non textuel', { last_name: ['Diop'] }],
  ])('validation 422 : %s', async (_l, corps) => {
    const p = await nouveauProprietaire();
    expect((await api().patch(COMPTE).set(p.h).send(corps)).status).toBe(422);
  });
});

describe('POST /compte/mot-de-passe', () => {
  test('mot de passe actuel faux : 401, aucune session fermée', async () => {
    const p = await nouveauProprietaire();
    const res = await changerMdp(p.h, 'Faux12345');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MOT_DE_PASSE_INCORRECT');
    expect((await api().get(COMPTE).set(p.h)).status).toBe(200);
  });

  test.each([
    ['nouveau mot de passe faible', { current_password: MOT_DE_PASSE, password: 'faible12', password_confirmation: 'faible12' }],
    ['confirmation différente', { current_password: MOT_DE_PASSE, password: NOUVEAU, password_confirmation: 'Autre1234' }],
    ['mot de passe actuel manquant', { password: NOUVEAU, password_confirmation: NOUVEAU }],
    ['corps vide', {}],
  ])('validation 422 : %s', async (_l, corps) => {
    const p = await nouveauProprietaire();
    expect((await api().post(`${COMPTE}/mot-de-passe`).set(p.h).send(corps)).status).toBe(422);
  });

  test('succès : audit, nouvelle session, ancien mot de passe refusé', async () => {
    const p = await nouveauProprietaire();
    const res = await changerMdp(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ access_token: expect.any(String), refresh_token: expect.any(String), token_type: 'Bearer' });
    expect(await compter('audit_logs', "action = 'compte.changement_mot_de_passe' AND entity_id = :u", { u: p.user.id })).toBe(1);
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE })).status).toBe(401);
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: NOUVEAU })).status).toBe(200);
  });
});

describe('CORRECTIF mot de passe provisoire (must_change_password)', () => {
  test('toute route refusée (403 CHANGEMENT_MOT_DE_PASSE_REQUIS) sauf profil, changement et déconnexion ; levé après changement', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query('UPDATE users SET must_change_password = true WHERE id = :u', { replacements: { u: p.user.id } });

    for (const [methode, chemin, corps] of [
      ['get', '/api/v1/immeubles'], ['get', '/api/v1/locataires'], ['get', '/api/v1/dashboard'], ['get', '/api/v1/parametres'],
      ['get', `${COMPTE}/sessions`], ['patch', COMPTE, { first_name: 'X' }], ['post', '/api/v1/immeubles', { name: 'R', address: 'A', city: 'Dakar' }],
      ['get', '/api/v1/notifications'], ['get', '/api/v1/abonnement'],
    ]) {
      const res = await api()[methode](chemin).set(p.h).send(corps);
      expect({ chemin, statut: res.status, code: res.body.error?.code }).toEqual({ chemin, statut: 403, code: 'CHANGEMENT_MOT_DE_PASSE_REQUIS' });
    }
    const profil = await api().get(`${COMPTE}/`).set(p.h);
    expect(profil.status).toBe(200);
    expect(profil.body.data.user.must_change_password).toBe(true);
    expect((await api().get(`${COMPTE}?x=1`).set(p.h)).status).toBe(200);
    expect(await compter('buildings', 'owner_id = :o', { o: p.ownerId })).toBe(0);

    const change = await changerMdp(p.h);
    expect(change.status).toBe(200);
    const h = bearer(change.body.data.access_token);
    expect((await api().get('/api/v1/immeubles').set(h)).status).toBe(200);
    expect((await api().get(COMPTE).set(h)).body.data.user.must_change_password).toBe(false);
  });

  test('super admin créé par un autre : console fermée jusqu’au changement du mot de passe provisoire', async () => {
    const admin = await superAdmin();
    const email2 = emailUnique('admin.provisoire');
    const provisoire = 'Xk9#vLq2!mRt';
    expect((await api().post('/api/v1/admin/utilisateurs').set(admin.h).send({ first_name: 'Awa', last_name: 'Sow', email: email2, password: provisoire, current_password: MOT_DE_PASSE })).status).toBe(201);
    const connexion = await api().post('/api/v1/auth/connexion').send({ identifiant: email2, password: provisoire });
    expect(connexion.status).toBe(200);
    expect(connexion.body.data.user.must_change_password).toBe(true);
    const h = bearer(connexion.body.data.access_token);
    const refus = await api().get('/api/v1/admin/dashboard').set(h);
    expect(refus.status).toBe(403);
    expect(refus.body.error.code).toBe('CHANGEMENT_MOT_DE_PASSE_REQUIS');
    expect((await api().post('/api/v1/admin/utilisateurs').set(h).send({ first_name: 'B', last_name: 'C', email: emailUnique('x'), password: provisoire })).status).toBe(403);

    const change = await changerMdp(h, provisoire, 'Zt7$pWq4!nBv');
    expect(change.status).toBe(200);
    // Mot de passe changé, mais double authentification pas encore configurée :
    // la console reste fermée (constat E1), seule la configuration est ouverte.
    const h2 = bearer(change.body.data.access_token);
    const sansMfa = await api().get('/api/v1/admin/dashboard').set(h2);
    expect(sansMfa.status).toBe(403);
    expect(sansMfa.body.error.code).toBe('MFA_REQUISE');
    const init = await api().post(`${COMPTE}/mfa/initialiser`).set(h2).send({ current_password: 'Zt7$pWq4!nBv' });
    expect(init.status).toBe(200);
    const active = await api().post(`${COMPTE}/mfa/activer`).set(h2).send({ code: codeTotp(init.body.data.secret) });
    expect(active.status).toBe(200);
    expect((await api().get('/api/v1/admin/dashboard').set(bearer(active.body.data.access_token))).status).toBe(200);
  });

  test('déconnexion possible avec un mot de passe provisoire', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query('UPDATE users SET must_change_password = true WHERE id = :u', { replacements: { u: p.user.id } });
    expect((await api().post('/api/v1/auth/deconnexion').set(p.h).send({ refresh_token: p.refreshToken })).status).toBe(200);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: p.refreshToken })).status).toBe(401);
  });
});

describe('Sessions', () => {
  test('liste : sessions actives seulement, session courante marquée, aucune empreinte', async () => {
    const p = await nouveauProprietaire();
    const tablette = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE, device_name: 'Tablette', platform: 'android' });
    await api().post('/api/v1/auth/deconnexion').send({ refresh_token: tablette.body.data.refresh_token });
    const res = await api().get(`${COMPTE}/sessions`).set(p.h).set('X-Refresh-Token', p.refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.data.sessions).toHaveLength(1);
    expect(res.body.data.sessions[0]).toMatchObject({ current: true, id: expect.any(String), last_used_at: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/token_hash/);
  });

  test('CORRECTIF client web (cookie httpOnly inaccessible) : session courante reconnue par le jeton d’accès, y compris après rotation', async () => {
    const p = await nouveauProprietaire();
    const tablette = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE, device_name: 'Tablette', platform: 'android' });
    const courantes = async (h) => (await api().get(`${COMPTE}/sessions`).set(h)).body.data.sessions.filter((s) => s.current);

    const web = await courantes(p.h);
    expect(web).toHaveLength(1);
    expect(web[0].device_name).not.toBe('Tablette');
    const cotéTablette = await courantes(bearer(tablette.body.data.access_token));
    expect(cotéTablette).toHaveLength(1);
    expect(cotéTablette[0].device_name).toBe('Tablette');

    const rot = await api().post('/api/v1/auth/refresh').send({ refresh_token: tablette.body.data.refresh_token });
    const apres = await courantes(bearer(rot.body.data.access_token));
    expect(apres).toHaveLength(1);
    expect(apres[0].device_name).toBe('Tablette');
  });

  test('fermer une session : la sienne 200 + audit ; celle d’un autre compte 404 et intacte ; UUID invalide 422', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const [[sessionB]] = await sequelize.query('SELECT id FROM refresh_tokens WHERE user_id = :u', { replacements: { u: b.user.id } });
    const autre = await api().delete(`${COMPTE}/sessions/${sessionB.id}`).set(a.h);
    expect(autre.status).toBe(404);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: b.refreshToken })).status).toBe(200);

    const [[sessionA]] = await sequelize.query('SELECT id FROM refresh_tokens WHERE user_id = :u', { replacements: { u: a.user.id } });
    expect((await api().delete(`${COMPTE}/sessions/${sessionA.id}`).set(a.h)).status).toBe(200);
    expect(await compter('audit_logs', "action = 'compte.deconnexion_distante' AND entity_id = :s", { s: sessionA.id })).toBe(1);
    expect((await api().delete(`${COMPTE}/sessions/${sessionA.id}`).set(a.h)).status).toBe(404);
    expect((await api().delete(`${COMPTE}/sessions/pas-un-uuid`).set(a.h)).status).toBe(422);
  });

  test('révoquer toutes : tous les jetons (accès et refresh) périmés, audit', async () => {
    const p = await nouveauProprietaire();
    const autre = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE });
    const res = await api().post(`${COMPTE}/sessions/revoquer-toutes`).set(p.h).send({});
    expect(res.status).toBe(200);
    for (const h of [p.h, bearer(autre.body.data.access_token)]) expect((await api().get(COMPTE).set(h)).status).toBe(401);
    for (const jeton of [p.refreshToken, autre.body.data.refresh_token]) expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: jeton })).status).toBe(401);
    expect(await compter('audit_logs', "action = 'compte.deconnexion_tous_appareils' AND entity_id = :u", { u: p.user.id })).toBe(1);
  });
});

describe('Appareils push', () => {
  const jeton = () => `fcm-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  test('enregistrement, ré-enregistrement du même jeton par un autre compte (transfert), retrait', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const t = jeton();
    expect((await api().post(`${COMPTE}/appareils`).set(a.h).send({ token: t, platform: 'android' })).status).toBe(200);
    expect(await compter('device_tokens', 'token = :t AND user_id = :u', { t, u: a.user.id })).toBe(1);
    expect((await api().post(`${COMPTE}/appareils`).set(a.h).send({ token: t, platform: 'android' })).status).toBe(200);
    expect(await compter('device_tokens', 'token = :t', { t })).toBe(1);

    expect((await api().post(`${COMPTE}/appareils`).set(b.h).send({ token: t, platform: 'ios' })).status).toBe(200);
    expect(await compter('device_tokens', 'token = :t AND user_id = :u', { t, u: b.user.id })).toBe(1);
    expect(await compter('device_tokens', 'token = :t AND user_id = :u', { t, u: a.user.id })).toBe(0);

    // A ne peut pas retirer l'appareil de B.
    expect((await api().delete(`${COMPTE}/appareils`).set(a.h).send({ token: t })).status).toBe(200);
    expect(await compter('device_tokens', 'token = :t', { t })).toBe(1);
    expect((await api().delete(`${COMPTE}/appareils`).set(b.h).send({ token: t })).status).toBe(200);
    expect(await compter('device_tokens', 'token = :t', { t })).toBe(0);
  });

  test.each([
    ['jeton trop court', { token: 'court', platform: 'android' }],
    ['jeton de 513 caractères', { token: 'x'.repeat(513), platform: 'android' }],
    ['plateforme inconnue', { token: 'jeton-valide-123', platform: 'windows' }],
    ['plateforme manquante', { token: 'jeton-valide-123' }],
    ['corps vide', {}],
  ])('validation 422 : %s', async (_l, corps) => {
    const p = await nouveauProprietaire();
    expect((await api().post(`${COMPTE}/appareils`).set(p.h).send(corps)).status).toBe(422);
  });

  test('retrait : jeton manquant → 422', async () => {
    const p = await nouveauProprietaire();
    expect((await api().delete(`${COMPTE}/appareils`).set(p.h).send({})).status).toBe(422);
  });
});
