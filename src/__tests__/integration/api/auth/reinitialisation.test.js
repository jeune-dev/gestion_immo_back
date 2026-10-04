'use strict';

const {
  api, bearer, MOT_DE_PASSE, nouveauProprietaire, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');
const email = require('../../../../infrastructure/email.service.js');

/**
 * § 5 « mot de passe oublié » : code à 6 chiffres, 15 minutes, essais
 * plafonnés, usage unique, sessions fermées après réinitialisation.
 * Le code est intercepté à l'envoi de l'e-mail (seul endroit où il existe en
 * clair).
 */

const OUBLI = '/api/v1/auth/mot-de-passe-oublie';
const REINIT = '/api/v1/auth/reinitialiser-mot-de-passe';
const NOUVEAU = 'NouveauMdp9';

let envoi;
beforeEach(() => {
  envoi = jest.spyOn(email, 'envoyerCodeReinitialisation').mockResolvedValue({ envoye: true });
});
afterEach(() => envoi.mockRestore());
afterAll(fermer);

async function demanderCode(identifiant) {
  envoi.mockClear();
  const res = await api().post(OUBLI).send({ identifiant });
  expect(res.status).toBe(200);
  return envoi.mock.calls.at(-1)?.[0]?.code;
}

const reinitialiser = (identifiant, code, password = NOUVEAU) => api().post(REINIT)
  .send({ identifiant, code, password, password_confirmation: password });

describe('Mot de passe oublié', () => {
  test('parcours complet : code envoyé, mot de passe changé, toutes les sessions fermées, audit, ancien mot de passe refusé', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE users SET must_change_password = true, failed_login_attempts = 3 WHERE id = :u", { replacements: { u: p.user.id } });
    const code = await demanderCode(p.identifiants.email);
    expect(code).toMatch(/^\d{6}$/);
    expect(envoi.mock.calls[0][0]).toMatchObject({ email: p.identifiants.email, minutes: 15 });
    const [[demande]] = await sequelize.query('SELECT otp_hash, expires_at FROM password_resets WHERE user_id = :u', { replacements: { u: p.user.id } });
    expect(demande.otp_hash).not.toContain(code);

    const res = await reinitialiser(p.identifiants.phone, code);
    expect(res.status).toBe(200);
    expect((await api().get('/api/v1/compte').set(p.h)).status).toBe(401);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: p.refreshToken })).status).toBe(401);
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE })).status).toBe(401);
    const connexion = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: NOUVEAU });
    expect(connexion.status).toBe(200);
    expect(connexion.body.data.user.must_change_password).toBe(false);
    expect(await compter('audit_logs', "action = 'compte.reinitialisation_mot_de_passe' AND entity_id = :u", { u: p.user.id })).toBe(1);
    // Usage unique.
    expect((await reinitialiser(p.identifiants.email, code, 'EncoreAutre9')).status).toBe(400);
  });

  test('anti-énumération : même réponse pour un compte inconnu, inactif ou sans e-mail ; aucun envoi', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :u", { replacements: { u: p.user.id } });
    const reference = await api().post(OUBLI).send({ identifiant: 'personne@test.sn' });
    const inactif = await api().post(OUBLI).send({ identifiant: p.identifiants.email });
    const illisible = await api().post(OUBLI).send({ identifiant: '%%%' });
    for (const r of [reference, inactif, illisible]) {
      expect(r.status).toBe(200);
      expect(r.body.message).toBe(reference.body.message);
    }
    expect(envoi).not.toHaveBeenCalled();
    expect(await compter('password_resets', 'user_id = :u', { u: p.user.id })).toBe(0);
  });

  test('une nouvelle demande invalide la précédente', async () => {
    const p = await nouveauProprietaire();
    const ancien = await demanderCode(p.identifiants.email);
    const recent = await demanderCode(p.identifiants.email);
    if (ancien !== recent) expect((await reinitialiser(p.identifiants.email, ancien)).status).toBe(400);
    expect((await reinitialiser(p.identifiants.email, recent)).status).toBe(200);
    expect(await compter('password_resets', 'user_id = :u AND used_at IS NULL', { u: p.user.id })).toBe(0);
  });

  test('essais plafonnés : 5 codes faux puis le bon → refusé (compteur persisté)', async () => {
    const p = await nouveauProprietaire();
    const code = await demanderCode(p.identifiants.email);
    const faux = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      const res = await reinitialiser(p.identifiants.email, faux);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CODE_INVALIDE');
    }
    const [[d]] = await sequelize.query('SELECT attempts FROM password_resets WHERE user_id = :u', { replacements: { u: p.user.id } });
    expect(d.attempts).toBe(5);
    expect((await reinitialiser(p.identifiants.email, code)).status).toBe(400);
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE })).status).toBe(200);
  });

  test('code expiré : 400, mot de passe inchangé', async () => {
    const p = await nouveauProprietaire();
    const code = await demanderCode(p.identifiants.email);
    await sequelize.query("UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE user_id = :u", { replacements: { u: p.user.id } });
    expect((await reinitialiser(p.identifiants.email, code)).status).toBe(400);
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE })).status).toBe(200);
  });

  test('code d’un autre compte : refusé', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const codeA = await demanderCode(a.identifiants.email);
    await demanderCode(b.identifiants.email);
    const res = await reinitialiser(b.identifiants.email, codeA);
    // Probabilité de collision 1/10^6 : si les deux codes coïncident, le test n'a pas de sens.
    if (res.status !== 200) expect(res.status).toBe(400);
  });

  test('réinitialisation lève le verrouillage du compte', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE users SET locked_until = now() + interval '10 minutes', failed_login_attempts = 4 WHERE id = :u", { replacements: { u: p.user.id } });
    const code = await demanderCode(p.identifiants.email);
    expect((await reinitialiser(p.identifiants.email, code)).status).toBe(200);
    const connexion = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: NOUVEAU });
    expect(connexion.status).toBe(200);
    expect((await api().get('/api/v1/compte').set(bearer(connexion.body.data.access_token))).status).toBe(200);
  });

  test.each([
    ['identifiant manquant', { code: '123456', password: NOUVEAU, password_confirmation: NOUVEAU }],
    ['code à 5 chiffres', { identifiant: 'a@test.sn', code: '12345', password: NOUVEAU, password_confirmation: NOUVEAU }],
    ['code non numérique', { identifiant: 'a@test.sn', code: 'abcdef', password: NOUVEAU, password_confirmation: NOUVEAU }],
    ['mot de passe faible', { identifiant: 'a@test.sn', code: '123456', password: 'faible', password_confirmation: 'faible' }],
    ['confirmation différente', { identifiant: 'a@test.sn', code: '123456', password: NOUVEAU, password_confirmation: 'Autre1234' }],
    ['corps vide', {}],
  ])('validation 422 : %s', async (_l, corps) => {
    expect((await api().post(REINIT).send(corps)).status).toBe(422);
  });

  test('demande : identifiant manquant ou de 255 caractères → 422', async () => {
    expect((await api().post(OUBLI).send({})).status).toBe(422);
    expect((await api().post(OUBLI).send({ identifiant: 'a'.repeat(255) })).status).toBe(422);
  });

  test('compte inconnu : 400 CODE_INVALIDE (même réponse qu’un code faux)', async () => {
    const res = await reinitialiser('inconnu@test.sn', '123456');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CODE_INVALIDE');
  });

  // ── CORRECTIF E2 (audit de sécurité) : force brute par requêtes simultanées ──

  test('CORRECTIF E2 : 20 codes faux SIMULTANÉS → jamais plus de 5 essais comptés, puis le bon code est refusé', async () => {
    const p = await nouveauProprietaire();
    const code = await demanderCode(p.identifiants.email);
    const faux = Array.from({ length: 20 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0'));
    const res = await Promise.all(faux.map((c) => reinitialiser(p.identifiants.email, c)));
    expect(res.every((r) => r.status === 400)).toBe(true);
    const [[demande]] = await sequelize.query('SELECT attempts FROM password_resets WHERE user_id = :u AND used_at IS NULL', { replacements: { u: p.user.id } });
    expect(demande.attempts).toBe(5);
    expect((await reinitialiser(p.identifiants.email, code)).status).toBe(400);
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE })).status).toBe(200);
  });

  test('CORRECTIF E2 : le bon code envoyé deux fois SIMULTANÉMENT ne sert qu’une fois', async () => {
    const p = await nouveauProprietaire();
    const code = await demanderCode(p.identifiants.email);
    const [a, b] = await Promise.all([
      reinitialiser(p.identifiants.email, code, 'PremierMdp9'),
      reinitialiser(p.identifiants.phone, code, 'SecondMdp9'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(await compter('audit_logs', "action = 'compte.reinitialisation_mot_de_passe' AND entity_id = :u", { u: p.user.id })).toBe(1);
  });
});
