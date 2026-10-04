'use strict';

const {
  api, bearer, MOT_DE_PASSE, nouveauProprietaire, creerLocataire, telephoneUnique, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 5 option B — activation du compte locataire par CODE (+ téléphone) ou par
 * LIEN ; rattachement d'une fiche à un compte locataire existant ; force brute
 * du code (§ 32).
 */

const ACTIVATION = '/api/v1/auth/locataire/activation';
const MDP_LOCATAIRE = 'Locataire9x';

afterAll(fermer);

async function inviter(proprio, tenant) {
  const res = await api().post(`/api/v1/locataires/${tenant.id}/invitation`).set(proprio.h).send({});
  expect(res.status).toBe(201);
  return res.body.data.invitation;
}

const activerParCode = (code, phone, password = MDP_LOCATAIRE, extra = {}) => api().post(ACTIVATION)
  .send({ code, phone, password, password_confirmation: password, ...extra });

const codeFaux = (code) => String((Number(code) + 1) % 100_000_000).padStart(8, '0');

async function preparer() {
  const proprio = await nouveauProprietaire();
  const tenant = await creerLocataire(proprio);
  const invitation = await inviter(proprio, tenant);
  return { proprio, tenant, invitation };
}

describe('Activation par code', () => {
  test('nominal : compte locataire créé, fiche rattachée, invitation consommée, audit, session ouverte', async () => {
    const { proprio, tenant, invitation } = await preparer();
    expect(invitation).toMatchObject({ code: expect.stringMatching(/^\d{8}$/), token: expect.any(String), expires_at: expect.any(String) });
    const res = await activerParCode(invitation.code, tenant.phone.replace('+221', ''), MDP_LOCATAIRE, { device_name: 'Tecno' });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ role: 'locataire', phone: tenant.phone, first_name: tenant.first_name });
    const [[fiche]] = await sequelize.query('SELECT user_id FROM tenants WHERE id = :t', { replacements: { t: tenant.id } });
    expect(fiche.user_id).toBe(res.body.data.user.id);
    expect(await compter('tenant_invitations', 'tenant_id = :t AND used_at IS NOT NULL', { t: tenant.id })).toBe(1);
    expect(await compter('audit_logs', "action = 'locataire.activation_compte' AND entity_id = :t AND owner_id = :o AND details->>'mode' = 'code'", { t: tenant.id, o: proprio.ownerId })).toBe(1);
    expect(await compter('refresh_tokens', "user_id = :u AND device_name = 'Tecno'", { u: res.body.data.user.id })).toBe(1);
    expect((await api().get('/api/v1/locataire/logement').set(bearer(res.body.data.access_token))).status).toBe(200);
    // Le propriétaire voit le compte actif ; une nouvelle invitation est refusée.
    const detail = await api().get(`/api/v1/locataires/${tenant.id}`).set(proprio.h);
    expect(detail.body.data.tenant).toMatchObject({ account_active: true, pending_invitation: null });
    const reinvitation = await api().post(`/api/v1/locataires/${tenant.id}/invitation`).set(proprio.h).send({});
    expect(reinvitation.status).toBe(409);
    expect(reinvitation.body.error.code).toBe('DEJA_ACTIVE');
  });

  test('CORRECTIF force brute : 5 codes faux puis le BON code → refusé (compteur d’essais persisté)', async () => {
    const { tenant, invitation } = await preparer();
    for (let i = 0; i < 5; i += 1) {
      const res = await activerParCode(codeFaux(invitation.code), tenant.phone);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVITATION_INVALIDE');
    }
    const [[inv]] = await sequelize.query('SELECT attempts FROM tenant_invitations WHERE tenant_id = :t AND revoked_at IS NULL', { replacements: { t: tenant.id } });
    expect(inv.attempts).toBe(5);
    const bon = await activerParCode(invitation.code, tenant.phone);
    expect(bon.status).toBe(400);
    expect(bon.body.error.code).toBe('INVITATION_INVALIDE');
    expect(await compter('users', 'phone = :p', { p: tenant.phone })).toBe(0);
    // Le lien de la même invitation est lui aussi épuisé.
    expect((await api().post(ACTIVATION).send({ token: invitation.token, password: MDP_LOCATAIRE, password_confirmation: MDP_LOCATAIRE })).status).toBe(400);
  });

  test('un essai faux est compté même sous forte concurrence (10 essais simultanés)', async () => {
    const { tenant, invitation } = await preparer();
    const faux = Array.from({ length: 10 }, (_, i) => String((Number(invitation.code) + i + 1) % 100_000_000).padStart(8, '0'));
    await Promise.all(faux.map((c) => activerParCode(c, tenant.phone)));
    const [[inv]] = await sequelize.query('SELECT attempts FROM tenant_invitations WHERE tenant_id = :t AND revoked_at IS NULL', { replacements: { t: tenant.id } });
    expect(inv.attempts).toBeGreaterThanOrEqual(5);
    expect((await activerParCode(invitation.code, tenant.phone)).status).toBe(400);
  });

  test('4 codes faux puis le bon : accepté (le plafond est de 5)', async () => {
    const { tenant, invitation } = await preparer();
    for (let i = 0; i < 4; i += 1) await activerParCode(codeFaux(invitation.code), tenant.phone);
    expect((await activerParCode(invitation.code, tenant.phone)).status).toBe(201);
  });

  test('bon code, mauvais téléphone : refusé, aucun compte créé', async () => {
    const { tenant, invitation } = await preparer();
    const res = await activerParCode(invitation.code, telephoneUnique());
    expect(res.status).toBe(400);
    expect(await compter('tenants', 'id = :t AND user_id IS NOT NULL', { t: tenant.id })).toBe(0);
  });

  test('invitation expirée, révoquée (remplacée) ou déjà utilisée : 400 INVITATION_INVALIDE', async () => {
    const a = await preparer();
    await sequelize.query("UPDATE tenant_invitations SET expires_at = now() - interval '1 minute' WHERE tenant_id = :t", { replacements: { t: a.tenant.id } });
    expect((await activerParCode(a.invitation.code, a.tenant.phone)).body.error.code).toBe('INVITATION_INVALIDE');

    const b = await preparer();
    const nouvelle = await inviter(b.proprio, b.tenant);
    expect(await compter('tenant_invitations', 'tenant_id = :t AND revoked_at IS NOT NULL', { t: b.tenant.id })).toBe(1);
    if (nouvelle.code !== b.invitation.code) expect((await activerParCode(b.invitation.code, b.tenant.phone)).status).toBe(400);
    expect((await activerParCode(nouvelle.code, b.tenant.phone)).status).toBe(201);
    // Utilisée : le lien de la même invitation ne sert plus.
    const lien = await api().post(ACTIVATION).send({ token: nouvelle.token, password: MDP_LOCATAIRE, password_confirmation: MDP_LOCATAIRE });
    expect(lien.status).toBe(400);
  });

  test('concurrence : deux activations simultanées avec le même code → un seul compte', async () => {
    const { tenant, invitation } = await preparer();
    const reponses = await Promise.all([activerParCode(invitation.code, tenant.phone), activerParCode(invitation.code, tenant.phone)]);
    expect(reponses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await compter('users', 'phone = :p', { p: tenant.phone })).toBe(1);
  });
});

describe('Activation par lien', () => {
  test('nominal : compte créé avec l’e-mail de la fiche, audit en mode « lien »', async () => {
    const { proprio, tenant, invitation } = await preparer();
    const res = await api().post(ACTIVATION).send({ token: invitation.token, password: MDP_LOCATAIRE, password_confirmation: MDP_LOCATAIRE });
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe(tenant.email);
    expect(await compter('audit_logs', "action = 'locataire.activation_compte' AND owner_id = :o AND details->>'mode' = 'lien'", { o: proprio.ownerId })).toBe(1);
  });

  test('jeton inconnu : 400 ; e-mail de la fiche déjà pris par un autre compte → compte créé sans e-mail', async () => {
    expect((await api().post(ACTIVATION).send({ token: 'x'.repeat(43), password: MDP_LOCATAIRE, password_confirmation: MDP_LOCATAIRE })).status).toBe(400);
    const autre = await nouveauProprietaire();
    const proprio = await nouveauProprietaire();
    const tenant = await creerLocataire(proprio, { email: autre.identifiants.email });
    const invitation = await inviter(proprio, tenant);
    const res = await api().post(ACTIVATION).send({ token: invitation.token, password: MDP_LOCATAIRE, password_confirmation: MDP_LOCATAIRE });
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBeNull();
  });
});

describe('Rattachement à un compte existant', () => {
  test('même téléphone chez un second bailleur : fiche rattachée au MÊME compte avec son mot de passe', async () => {
    const a = await preparer();
    const premier = await activerParCode(a.invitation.code, a.tenant.phone);
    expect(premier.status).toBe(201);

    const proprioB = await nouveauProprietaire();
    const ficheB = await creerLocataire(proprioB, { phone: a.tenant.phone });
    const invB = await inviter(proprioB, ficheB);
    const second = await activerParCode(invB.code, a.tenant.phone);
    expect(second.status).toBe(201);
    expect(second.body.data.user.id).toBe(premier.body.data.user.id);
    expect(await compter('users', 'phone = :p', { p: a.tenant.phone })).toBe(1);
    expect(await compter('tenants', 'user_id = :u', { u: premier.body.data.user.id })).toBe(2);
    const accueil = await api().get('/api/v1/locataire/logement').set(bearer(second.body.data.access_token));
    expect(accueil.status).toBe(200);
  });

  test('mauvais mot de passe du compte existant : 401, essai décompté, 5 échecs épuisent l’invitation', async () => {
    const a = await preparer();
    expect((await activerParCode(a.invitation.code, a.tenant.phone)).status).toBe(201);
    const proprioB = await nouveauProprietaire();
    const ficheB = await creerLocataire(proprioB, { phone: a.tenant.phone });
    const invB = await inviter(proprioB, ficheB);

    const refus = await activerParCode(invB.code, a.tenant.phone, 'AutreMdp123');
    expect(refus.status).toBe(401);
    expect(refus.body.error.code).toBe('COMPTE_EXISTANT_MOT_DE_PASSE');
    const [[inv]] = await sequelize.query('SELECT attempts FROM tenant_invitations WHERE tenant_id = :t AND revoked_at IS NULL', { replacements: { t: ficheB.id } });
    expect(inv.attempts).toBe(1);
    for (let i = 0; i < 4; i += 1) await activerParCode(invB.code, a.tenant.phone, `AutreMdp12${i}`);
    // Invitation épuisée : même le bon mot de passe ne rattache plus la fiche.
    expect((await activerParCode(invB.code, a.tenant.phone)).status).toBe(400);
    expect(await compter('tenants', 'id = :t AND user_id IS NULL', { t: ficheB.id })).toBe(1);
  });

  test('téléphone déjà utilisé par un compte propriétaire : 409 TELEPHONE_UTILISE', async () => {
    const proprio = await nouveauProprietaire();
    const autreProprio = await nouveauProprietaire();
    const tenant = await creerLocataire(proprio, { phone: autreProprio.identifiants.phone });
    const invitation = await inviter(proprio, tenant);
    const res = await activerParCode(invitation.code, tenant.phone, MOT_DE_PASSE);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TELEPHONE_UTILISE');
    // Rien n'est consommé : l'invitation reste valide.
    expect(await compter('tenant_invitations', 'tenant_id = :t AND used_at IS NULL AND revoked_at IS NULL', { t: tenant.id })).toBe(1);
  });

  test('compte locataire existant mais désactivé : 403 COMPTE_INACTIF, fiche non rattachée', async () => {
    const a = await preparer();
    const premier = await activerParCode(a.invitation.code, a.tenant.phone);
    await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :u", { replacements: { u: premier.body.data.user.id } });
    const proprioB = await nouveauProprietaire();
    const ficheB = await creerLocataire(proprioB, { phone: a.tenant.phone });
    const invB = await inviter(proprioB, ficheB);
    const res = await activerParCode(invB.code, a.tenant.phone);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COMPTE_INACTIF');
    expect(await compter('tenants', 'id = :t AND user_id IS NULL', { t: ficheB.id })).toBe(1);
  });
});

describe('Validation', () => {
  test.each([
    ['ni code ni lien', { phone: '+221771234567' }],
    ['code ET lien', { code: '12345678', token: 'abc', phone: '+221771234567' }],
    ['code sans téléphone', { code: '12345678' }],
    ['code à 7 chiffres', { code: '1234567', phone: '+221771234567' }],
    ['code non numérique', { code: 'abcdefgh', phone: '+221771234567' }],
    ['téléphone invalide', { code: '12345678', phone: 'abc' }],
    ['lien de 201 caractères', { token: 'a'.repeat(201) }],
  ])('422 : %s', async (_l, corps) => {
    const res = await api().post(ACTIVATION).send({ password: MDP_LOCATAIRE, password_confirmation: MDP_LOCATAIRE, ...corps });
    expect(res.status).toBe(422);
  });

  test('mot de passe faible ou confirmation différente : 422, aucun essai consommé', async () => {
    const { tenant, invitation } = await preparer();
    expect((await activerParCode(invitation.code, tenant.phone, 'faible')).status).toBe(422);
    const diff = await api().post(ACTIVATION).send({ code: invitation.code, phone: tenant.phone, password: MDP_LOCATAIRE, password_confirmation: 'Autre1234' });
    expect(diff.status).toBe(422);
    expect(await compter('tenant_invitations', 'tenant_id = :t AND attempts = 0', { t: tenant.id })).toBe(1);
  });

  test('élévation : role_code / user_id / tenant_id envoyés sont ignorés', async () => {
    const { tenant, invitation } = await preparer();
    const res = await activerParCode(invitation.code, tenant.phone, MDP_LOCATAIRE, { role_code: 'super_admin', user_id: '00000000-0000-4000-8000-000000000000', tenant_id: tenant.id });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('locataire');
  });
});
