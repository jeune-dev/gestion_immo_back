'use strict';

const {
  api, apiBrute, bearer, MOT_DE_PASSE, nouveauProprietaire, superAdmin, codeTotp, creerLocataire, bailActif,
  activerLocataire, pngTest, compter, fermer, sequelize, telephoneUnique, emailUnique, dernierCodeWhatsapp,
} = require('../../../setup/helpers.js');
const whatsapp = require('../../../../infrastructure/whatsapp.service.js');
const { purgerPiecesIdentite } = require('../../../../jobs/retention.js');

/**
 * Correctifs de l'audit de sécurité de novembre 2026 :
 *   E2 invitation locataire envoyée au SEUL WhatsApp du locataire ;
 *   M1 ré-authentification avant de changer un moyen de paiement ;
 *   M4 suppression de compte (anonymisation) et purge des pièces d'identité ;
 *   F4 révocation immédiate d'une session.
 */

afterAll(fermer);

const MOYENS = '/api/v1/paiements/moyens';
const WAVE = { provider: 'wave', mode: 'preuve', account_number: '771112233' };

describe('M1 — moyens de paiement : ré-authentification obligatoire', () => {
  test('sans mot de passe : 422 ; mot de passe faux : 401 sans modification ; bon mot de passe : 200', async () => {
    const p = await nouveauProprietaire();
    expect((await apiBrute().put(MOYENS).set(p.h).send(WAVE)).status).toBe(422);
    const faux = await apiBrute().put(MOYENS).set(p.h).send({ ...WAVE, current_password: 'Mauvais9xyz' });
    expect(faux.status).toBe(401);
    expect(faux.body.error.code).toBe('MOT_DE_PASSE_INCORRECT');
    expect(await compter('payment_providers', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    const bon = await apiBrute().put(MOYENS).set(p.h).send({ ...WAVE, current_password: MOT_DE_PASSE });
    expect(bon.status).toBe(200);
    expect(bon.body.data.provider).not.toHaveProperty('current_password');
  });

  test('double authentification active : le code est exigé en plus du mot de passe', async () => {
    const p = await nouveauProprietaire();
    const init = await api().post('/api/v1/compte/mfa/initialiser').set(p.h).send({ current_password: MOT_DE_PASSE });
    expect(init.status).toBe(200);
    const { secret } = init.body.data;
    const activation = await api().post('/api/v1/compte/mfa/activer').set(p.h).send({ code: codeTotp(secret) });
    expect(activation.status).toBe(200);
    const h = activation.body.data?.access_token ? bearer(activation.body.data.access_token) : p.h;
    const sansCode = await apiBrute().put(MOYENS).set(h).send({ ...WAVE, current_password: MOT_DE_PASSE });
    expect(sansCode.status).toBe(401);
    expect(sansCode.body.error.code).toBe('CODE_MFA_REQUIS');
    expect((await apiBrute().put(MOYENS).set(h).send({ ...WAVE, current_password: MOT_DE_PASSE, code: codeTotp(secret, 1) })).status).toBe(200);
  });
});

describe('M4 — suppression du compte', () => {
  const SUPPRESSION = '/api/v1/compte/suppression';
  const confirmer = (h, surcharges = {}) => api().post(SUPPRESSION).set(h)
    .send({ current_password: MOT_DE_PASSE, confirmation: 'SUPPRIMER', ...surcharges });

  test('propriétaire sans bail actif : compte anonymisé, sessions fermées, espace suspendu', async () => {
    const p = await nouveauProprietaire();
    expect((await confirmer(p.h, { confirmation: 'oui' })).status).toBe(422);
    expect((await confirmer(p.h, { current_password: 'Mauvais9xyz' })).status).toBe(401);
    const res = await confirmer(p.h);
    expect(res.status).toBe(200);
    const [[u]] = await sequelize.query('SELECT first_name, email, phone, status, anonymized_at, deleted_at, totp_secret FROM users WHERE id = :id', { replacements: { id: p.user.id } });
    expect(u).toMatchObject({ first_name: 'Compte', phone: null, status: 'inactif', totp_secret: null });
    expect(u.email).toMatch(/@anonyme\.invalid$/);
    expect(u.anonymized_at).not.toBeNull();
    expect(u.deleted_at).not.toBeNull();
    expect(await compter('owners', "id = :o AND status = 'suspendu'", { o: p.ownerId })).toBe(1);
    expect(await compter('refresh_tokens', 'user_id = :u AND revoked_at IS NULL', { u: p.user.id })).toBe(0);
    expect(await compter('audit_logs', "action = 'compte.suppression' AND entity_id = :u", { u: p.user.id })).toBe(1);
    // Le jeton d'accès en circulation ne passe plus, ni la connexion.
    expect((await api().get('/api/v1/compte').set(p.h)).status).toBe(401);
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.phone, password: MOT_DE_PASSE })).status).toBe(401);
    // Le numéro et l'e-mail sont libérés : une nouvelle inscription est possible.
    const neuf = await nouveauProprietaire({ phone: p.identifiants.phone, email: p.identifiants.email });
    expect(neuf.user.id).not.toBe(p.user.id);
  });

  test('propriétaire avec un bail actif : 409 BAUX_ACTIFS, rien n’est modifié', async () => {
    const p = await nouveauProprietaire();
    await bailActif(p);
    const res = await confirmer(p.h);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BAUX_ACTIFS');
    expect(await compter('users', 'id = :u AND anonymized_at IS NULL AND deleted_at IS NULL', { u: p.user.id })).toBe(1);
  });

  test('locataire : compte anonymisé, fiche du bailleur conservée et détachée (réinvitation possible)', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p);
    const l = await activerLocataire(p, t);
    expect((await confirmer(l.h)).status).toBe(200);
    const [[fiche]] = await sequelize.query('SELECT user_id, first_name, deleted_at FROM tenants WHERE id = :t', { replacements: { t: t.id } });
    expect(fiche).toEqual({ user_id: null, first_name: t.first_name, deleted_at: null });
    expect((await api().post(`/api/v1/locataires/${t.id}/invitation`).set(p.h).send({})).status).toBe(201);
  });

  test('super administrateur : 403 (retrait par un autre super administrateur uniquement)', async () => {
    const admin = await superAdmin();
    const res = await api().post(SUPPRESSION).set(admin.h)
      .send({ current_password: MOT_DE_PASSE, confirmation: 'SUPPRIMER', code: codeTotp(admin.secret, 1) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SUPPRESSION_INTERDITE');
  });
});

describe('M4 — purge des pièces d’identité (12 mois après le dernier bail)', () => {
  test('purge le numéro chiffré et les fichiers ; épargne les baux actifs et les fiches récentes', async () => {
    const p = await nouveauProprietaire();
    const ancien = await creerLocataire(p, { id_document_type: 'cni', id_document_number: '1 234 567 890 12' });
    const recent = await creerLocataire(p, { id_document_type: 'cni', id_document_number: '9 876 543 210 98' });
    const enCours = await bailActif(p);
    await api().patch(`/api/v1/locataires/${enCours.tenant.id}`).set(p.h).send({ id_document_type: 'cni', id_document_number: '5 555 555 555 55' });
    const doc = await api().post('/api/v1/documents').set(p.h)
      .field('entity_type', 'tenant').field('entity_id', ancien.id).field('category', 'piece_identite')
      .attach('fichier', await pngTest(), 'cni.png');
    expect(doc.status).toBe(201);
    // Fiche créée il y a 13 mois (jamais de bail) ; une autre il y a 2 mois.
    await sequelize.query("UPDATE tenants SET created_at = now() - interval '13 months' WHERE id = :t", { replacements: { t: ancien.id } });
    await sequelize.query("UPDATE tenants SET created_at = now() - interval '2 months' WHERE id = :t", { replacements: { t: recent.id } });

    const bilan = await purgerPiecesIdentite();
    expect(bilan.locataires).toBeGreaterThanOrEqual(1);
    const [[a]] = await sequelize.query('SELECT id_document_number, id_document_purged_at FROM tenants WHERE id = :t', { replacements: { t: ancien.id } });
    expect(a.id_document_number).toBeNull();
    expect(a.id_document_purged_at).not.toBeNull();
    expect(await compter('documents', "(tenant_id = :t OR entity_id = :t) AND category = 'piece_identite' AND deleted_at IS NULL", { t: ancien.id })).toBe(0);
    expect(await compter('tenants', 'id = :t AND id_document_number IS NOT NULL', { t: recent.id })).toBe(1);
    expect(await compter('tenants', 'id = :t AND id_document_number IS NOT NULL', { t: enCours.tenant.id })).toBe(1);
    expect(await compter('audit_logs', "action = 'locataire.purge_piece_identite' AND entity_id = :t", { t: ancien.id })).toBe(1);
    // Idempotent : un second passage ne reprend pas la même fiche.
    await purgerPiecesIdentite();
    expect(await compter('audit_logs', "action = 'locataire.purge_piece_identite' AND entity_id = :t", { t: ancien.id })).toBe(1);
  });
});

describe('F4 — révocation immédiate d’une session', () => {
  test('« déconnecter cet appareil » : le jeton d’accès de cet appareil est refusé aussitôt', async () => {
    const p = await nouveauProprietaire();
    const autre = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: MOT_DE_PASSE, device_name: 'Autre' });
    const hAutre = bearer(autre.body.data.access_token);
    expect((await api().get('/api/v1/compte').set(hAutre)).status).toBe(200);
    const liste = await api().get('/api/v1/compte/sessions').set(p.h);
    const cible = liste.body.data.sessions.find((s) => s.device_name === 'Autre');
    expect((await api().delete(`/api/v1/compte/sessions/${cible.id}`).set(p.h)).status).toBe(200);
    const apres = await api().get('/api/v1/compte').set(hAutre);
    expect(apres.status).toBe(401);
    expect(apres.body.error.code).toBe('SESSION_REVOQUEE');
    expect((await api().get('/api/v1/compte').set(p.h)).status).toBe(200);
  });

  test('déconnexion : le jeton d’accès de la session fermée est refusé aussitôt', async () => {
    const p = await nouveauProprietaire();
    expect((await api().post('/api/v1/auth/deconnexion').send({ refresh_token: p.refreshToken })).status).toBe(200);
    expect((await api().get('/api/v1/compte').set(p.h)).status).toBe(401);
  });
});

describe('Invitation locataire (E2)', () => {
  test('le propriétaire ne reçoit ni code ni lien ; le code part au WhatsApp du locataire', async () => {
    const p = await nouveauProprietaire();
    const res = await api().post('/api/v1/locataires').set(p.h)
      .send({ first_name: 'Moussa', last_name: 'Sy', phone: telephoneUnique(), email: emailUnique('loc'), send_invitation: true });
    expect(res.status).toBe(201);
    expect(res.body.data.invitation).toEqual({ expires_at: expect.any(String), canal: 'whatsapp' });
    const code = dernierCodeWhatsapp(res.body.data.tenant.phone);
    expect(code).toMatch(/^\d{8}$/);
    expect(JSON.stringify(res.body)).not.toContain(code);
  });

  test('échec d’envoi : canal « echec » (le propriétaire peut renvoyer l’invitation)', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p);
    const espion = jest.spyOn(whatsapp, 'envoyerCode').mockRejectedValueOnce(new Error('panne'));
    try {
      const res = await api().post(`/api/v1/locataires/${t.id}/invitation`).set(p.h).send({});
      expect(res.status).toBe(201);
      expect(res.body.data.invitation.canal).toBe('echec');
    } finally {
      espion.mockRestore();
    }
  });

  test('l’e-mail saisi par le bailleur n’est PAS recopié dans le compte locataire ; téléphone vérifié', async () => {
    const p = await nouveauProprietaire();
    const email = emailUnique('saisi-par-bailleur');
    const t = await creerLocataire(p, { email });
    await api().post(`/api/v1/locataires/${t.id}/invitation`).set(p.h).send({});
    const res = await api().post('/api/v1/auth/locataire/activation')
      .send({ code: dernierCodeWhatsapp(t.phone), phone: t.phone, password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE });
    expect(res.status).toBe(201);
    const [[u]] = await sequelize.query('SELECT email, phone_verified_at FROM users WHERE id = :id', { replacements: { id: res.body.data.user.id } });
    expect(u.email).toBeNull();
    expect(u.phone_verified_at).not.toBeNull();
    // « Mot de passe oublié » sur l'e-mail du bailleur n'atteint aucun compte.
    expect(await compter('users', 'lower(email) = :e', { e: email })).toBe(0);
  });
});
