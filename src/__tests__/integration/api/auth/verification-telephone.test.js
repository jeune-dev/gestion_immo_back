'use strict';

const {
  api, MOT_DE_PASSE, nouveauProprietaire, creerLocataire, telephoneUnique, emailUnique, compter, fermer, sequelize,
  codeInscription, dernierCodeWhatsapp,
} = require('../../../setup/helpers.js');
const whatsapp = require('../../../../infrastructure/whatsapp.service.js');

/**
 * Constat E2 de l'audit de sécurité : preuve de possession du téléphone par
 * code WhatsApp (inscription) et invitation locataire envoyée au SEUL
 * locataire (le bailleur ne reçoit ni le code ni le lien).
 */

const CODE = '/api/v1/auth/inscription/code';
const INSCRIPTION = '/api/v1/auth/inscription';
const corps = (phone, surcharges = {}) => ({
  first_name: 'Awa', last_name: 'Fall', phone, email: emailUnique('verif'), password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE, ...surcharges,
});

afterAll(fermer);

describe('Vérification du téléphone à l’inscription', () => {
  test('code envoyé par WhatsApp : réponse générique, seule l’empreinte est stockée', async () => {
    const phone = telephoneUnique();
    const res = await api().post(CODE).send({ phone: phone.replace('+221', '') });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ canal: 'whatsapp', expires_in: 600 });
    const code = dernierCodeWhatsapp(phone);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(res.body)).not.toContain(code);
    const [[ligne]] = await sequelize.query('SELECT code_hash FROM phone_verifications WHERE phone = :p ORDER BY created_at DESC LIMIT 1', { replacements: { p: phone } });
    expect(ligne.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ligne.code_hash).not.toContain(code);
  });

  test('numéro déjà inscrit : même réponse (pas d’énumération)', async () => {
    const p = await nouveauProprietaire();
    const res = await api().post(CODE).send({ phone: p.identifiants.phone });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ canal: 'whatsapp', expires_in: 600 });
  });

  test('inscription avec le bon code : 201, téléphone marqué vérifié, code consommé (rejouer → 400)', async () => {
    const phone = telephoneUnique();
    const code = await codeInscription(phone);
    const res = await api().post(INSCRIPTION).send(corps(phone, { code }));
    expect(res.status).toBe(201);
    const [[u]] = await sequelize.query('SELECT phone_verified_at FROM users WHERE id = :id', { replacements: { id: res.body.data.user.id } });
    expect(u.phone_verified_at).not.toBeNull();
    const rejeu = await api().post(INSCRIPTION).send(corps(telephoneUnique(), { code }));
    expect(rejeu.status).toBe(400);
  });

  test('code d’un AUTRE numéro refusé (on ne peut pas inscrire le numéro d’un tiers)', async () => {
    const monNumero = telephoneUnique();
    const victime = telephoneUnique();
    const code = await codeInscription(monNumero);
    const res = await api().post(INSCRIPTION).send(corps(victime, { code }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CODE_TELEPHONE_INVALIDE');
    expect(await compter('users', 'phone = :p', { p: victime })).toBe(0);
  });

  test('force brute : 5 codes faux puis le BON → refusé ; un nouveau code annule l’ancien', async () => {
    const phone = telephoneUnique();
    const code = await codeInscription(phone);
    const faux = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i += 1) expect((await api().post(INSCRIPTION).send(corps(phone, { code: faux }))).status).toBe(400);
    expect((await api().post(INSCRIPTION).send(corps(phone, { code }))).status).toBe(400);
    const ancien = await codeInscription(phone);
    const nouveau = await codeInscription(phone);
    if (ancien !== nouveau) expect((await api().post(INSCRIPTION).send(corps(phone, { code: ancien }))).status).toBe(400);
    expect((await api().post(INSCRIPTION).send(corps(phone, { code: nouveau }))).status).toBe(201);
  });

  test('code expiré refusé', async () => {
    const phone = telephoneUnique();
    const code = await codeInscription(phone);
    await sequelize.query("UPDATE phone_verifications SET expires_at = now() - interval '1 second' WHERE phone = :p", { replacements: { p: phone } });
    expect((await api().post(INSCRIPTION).send(corps(phone, { code }))).status).toBe(400);
  });

  test('sans code : 422', async () => {
    expect((await api().post(INSCRIPTION).send(corps(telephoneUnique()))).status).toBe(422);
  });

  test('production sans WhatsApp configuré : 503, aucun code créé', async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const phone = telephoneUnique();
    try {
      const res = await api().post(CODE).send({ phone });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('WHATSAPP_INDISPONIBLE');
    } finally {
      process.env.NODE_ENV = env;
    }
    expect(await compter('phone_verifications', 'phone = :p', { p: phone })).toBe(0);
  });

  test('échec d’envoi WhatsApp : 503 WHATSAPP_ECHEC', async () => {
    const espion = jest.spyOn(whatsapp, 'envoyerCode').mockRejectedValueOnce(new Error('numéro sans WhatsApp'));
    try {
      const res = await api().post(CODE).send({ phone: telephoneUnique() });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('WHATSAPP_ECHEC');
    } finally {
      espion.mockRestore();
    }
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
