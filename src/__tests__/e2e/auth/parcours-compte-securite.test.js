'use strict';

const crypto = require('crypto');
const {
  api, bearer, MOT_DE_PASSE, nouveauProprietaire, compter, fermer, sequelize,
} = require('../../setup/helpers.js');

/**
 * PARCOURS E2E — cycle de vie d'un compte (§ 5, § 32).
 *
 * connexion sur deux appareils → rafraîchissement (rotation) → liste des
 * sessions → déconnexion à distance d'un appareil → mot de passe oublié
 * (code à usage unique) → toutes les sessions tombent → reconnexion →
 * verrouillage après échecs → déconnexion.
 */
describe('E2E — compte et sessions', () => {
  afterAll(fermer);

  test('parcours complet', async () => {
    const p = await nouveauProprietaire();
    const { email, phone } = p.identifiants;

    // Deux appareils.
    const tel = (await api().post('/api/v1/auth/connexion').send({ identifiant: phone, password: MOT_DE_PASSE, device_name: 'Téléphone', platform: 'android' })).body.data;
    const tablette = (await api().post('/api/v1/auth/connexion').send({ identifiant: email, password: MOT_DE_PASSE, device_name: 'Tablette', platform: 'ios' })).body.data;

    // Rotation du refresh token : l'ancien ne sert plus.
    const r1 = (await api().post('/api/v1/auth/refresh').send({ refresh_token: tel.refresh_token })).body.data;
    expect(r1.refresh_token).not.toBe(tel.refresh_token);

    // Sessions actives, puis déconnexion distante de la tablette (§ 32).
    const sessions = (await api().get('/api/v1/compte/sessions').set(bearer(r1.access_token))).body.data.sessions;
    const idTablette = sessions.find((s) => s.device_name === 'Tablette').id;
    expect((await api().delete(`/api/v1/compte/sessions/${idTablette}`).set(bearer(r1.access_token))).status).toBe(200);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: tablette.refresh_token })).status).toBe(401);

    // Mot de passe oublié : le code (6 chiffres) est connu ici en le déposant
    // comme le ferait le service (même empreinte HMAC), l'e-mail n'étant pas envoyé en test.
    expect((await api().post('/api/v1/auth/mot-de-passe-oublie').send({ identifiant: email })).status).toBe(200);
    const code = '482913';
    await sequelize.query(
      `UPDATE password_resets SET otp_hash = :h WHERE id = (SELECT id FROM password_resets WHERE user_id = :u ORDER BY created_at DESC LIMIT 1)`,
      { replacements: { u: p.user.id, h: crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${p.user.id}:${code}`).digest('hex') } }
    );
    const nouveau = 'NouveauMotDePasse7';
    expect((await api().post('/api/v1/auth/reinitialiser-mot-de-passe').send({ identifiant: email, code, password: nouveau, password_confirmation: nouveau })).status).toBe(200);
    // Code à usage unique, anciennes sessions et jetons révoqués.
    expect((await api().post('/api/v1/auth/reinitialiser-mot-de-passe').send({ identifiant: email, code, password: nouveau, password_confirmation: nouveau })).status).toBe(400);
    expect((await api().get('/api/v1/compte').set(bearer(r1.access_token))).status).toBe(401);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: r1.refresh_token })).status).toBe(401);
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: email, password: MOT_DE_PASSE })).status).toBe(401);

    // Reconnexion avec le nouveau mot de passe ; journal des actions sensibles.
    const reco = await api().post('/api/v1/auth/connexion').send({ identifiant: email, password: nouveau });
    expect(reco.status).toBe(200);
    expect(await compter('audit_logs', "user_id = :u AND action IN ('compte.deconnexion_distante', 'compte.reinitialisation_mot_de_passe')", { u: p.user.id })).toBe(2);

    // Verrouillage après 5 échecs (§ 32 anti force brute), même avec le bon mot de passe ensuite.
    for (let i = 0; i < 5; i += 1) await api().post('/api/v1/auth/connexion').send({ identifiant: email, password: 'Mauvais9x' });
    // Réponse identique à un mot de passe faux : le blocage ne se révèle pas (constat M4).
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: email, password: nouveau })).body.error.code).toBe('IDENTIFIANTS_INVALIDES');

    // Déconnexion : la session courante est fermée.
    expect((await api().post('/api/v1/auth/deconnexion').send({ refresh_token: reco.body.data.refresh_token })).status).toBe(200);
    expect((await api().post('/api/v1/auth/refresh').send({ refresh_token: reco.body.data.refresh_token })).status).toBe(401);
  });
});
