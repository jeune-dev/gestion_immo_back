'use strict';

const {
  api, nouveauProprietaire, superAdmin, proprietaireEtLocataire, expirerAbonnement, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');
const { DEFAUTS_PROPRIETAIRE } = require('../../../../config/parametres.js');

/**
 * Paramètres de l'espace propriétaire : délais de relance (§ 14), politique
 * d'état des lieux (§ 52.4), canaux (§ 54.3) et identité du bailleur (§ 13, § 53).
 */

const URL = '/api/v1/parametres';

afterAll(fermer);

describe('Lecture', () => {
  test('valeurs par défaut du cahier des charges et identité du bailleur', async () => {
    const p = await nouveauProprietaire();
    const res = await api().get(URL).set(p.h);
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toEqual({ ...DEFAUTS_PROPRIETAIRE });
    expect(res.body.data.settings.reminder_offsets).toEqual([-3, 0, 3, 7, 15]);
    expect(res.body.data.owner).toMatchObject({ id: p.ownerId, display_name: 'Balla Diop' });
  });
});

describe('Réglages', () => {
  test('modification partielle : fusion avec l’existant, audit avec différence', async () => {
    const p = await nouveauProprietaire();
    const res = await api().patch(URL).set(p.h).send({ reminder_offsets: [-5, 0, 10], late_grace_days: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data.settings).toMatchObject({ reminder_offsets: [-5, 0, 10], late_grace_days: 3, entry_inspection_policy: 'bloquant' });
    await api().patch(URL).set(p.h).send({ entry_inspection_policy: 'desactive' });
    const relu = await api().get(URL).set(p.h);
    expect(relu.body.data.settings).toMatchObject({ reminder_offsets: [-5, 0, 10], entry_inspection_policy: 'desactive' });
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'parametres.modification' AND owner_id = :o ORDER BY created_at LIMIT 1", { replacements: { o: p.ownerId } });
    expect(audit.details).toEqual({ reminder_offsets: { avant: [-3, 0, 3, 7, 15], apres: [-5, 0, 10] }, late_grace_days: { avant: 0, apres: 3 } });
  });

  test.each([
    ['corps vide', {}],
    ['délais non uniques', { reminder_offsets: [0, 0] }],
    ['délai hors bornes', { reminder_offsets: [-31] }],
    ['liste de délais vide', { reminder_offsets: [] }],
    ['11 délais', { reminder_offsets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
    ['grâce négative', { late_grace_days: -1 }],
    ['grâce de 31 jours', { late_grace_days: 31 }],
    ['politique inconnue', { entry_inspection_policy: 'parfois' }],
    ['délai de réponse nul', { inspection_response_days: 0 }],
    ['restitution de 181 jours', { deposit_refund_days: 181 }],
    ['canal inconnu', { channel_order: ['pigeon'] }],
    ['canaux en double', { channel_order: ['push', 'push'] }],
    ['stratégie inconnue', { notification_strategy: 'aleatoire' }],
    ['type incorrect', { late_grace_days: 'trois' }],
  ])('validation 422 : %s — réglages inchangés', async (_l, corps) => {
    const p = await nouveauProprietaire();
    expect((await api().patch(URL).set(p.h).send(corps)).status).toBe(422);
    const [[o]] = await sequelize.query('SELECT settings FROM owners WHERE id = :o', { replacements: { o: p.ownerId } });
    expect(o.settings || {}).toEqual({});
  });

  test('clé inconnue ignorée (jamais écrite dans owners.settings)', async () => {
    const p = await nouveauProprietaire();
    const res = await api().patch(URL).set(p.h).send({ late_grace_days: 2, pirate: true, status: 'suspendu' });
    expect(res.status).toBe(200);
    const [[o]] = await sequelize.query('SELECT settings, status FROM owners WHERE id = :o', { replacements: { o: p.ownerId } });
    expect(o.settings).toEqual({ late_grace_days: 2 });
    expect(o.status).toBe('actif');
  });
});

describe('Identité du bailleur', () => {
  test('modification : champs autorisés seulement (status, user_id ignorés), audit', async () => {
    const p = await nouveauProprietaire();
    const autre = await nouveauProprietaire();
    const res = await api().patch(`${URL}/profil`).set(p.h).send({
      display_name: 'SCI Diop & Fils', company_name: 'SCI Diop', phone: '77 000 11 22', email: 'CONTACT@SCI-DIOP.SN', address: 'Mermoz', city: 'Dakar',
      status: 'suspendu', user_id: autre.user.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.owner).toMatchObject({ display_name: 'SCI Diop & Fils', phone: '+221770001122', email: 'contact@sci-diop.sn', status: 'actif', user_id: p.user.id });
    expect(await compter('audit_logs', "action = 'parametres.modification_profil' AND owner_id = :o", { o: p.ownerId })).toBe(1);
  });

  test.each([
    ['corps vide', {}],
    ['nom d’affichage d’un caractère', { display_name: 'A' }],
    ['nom d’affichage de 151 caractères', { display_name: 'n'.repeat(151) }],
    ['téléphone invalide', { phone: 'abc' }],
    ['e-mail invalide', { email: 'x@' }],
    ['adresse de 256 caractères', { address: 'a'.repeat(256) }],
  ])('validation 422 : %s', async (_l, corps) => {
    const p = await nouveauProprietaire();
    expect((await api().patch(`${URL}/profil`).set(p.h).send(corps)).status).toBe(422);
  });
});

describe('Accès', () => {
  test('locataire, super admin : 403 ; anonyme : 401', async () => {
    const { locataire } = await proprietaireEtLocataire();
    const admin = await superAdmin();
    for (const h of [locataire.h, admin.h]) {
      expect((await api().get(URL).set(h)).status).toBe(403);
      expect((await api().patch(URL).set(h).send({ late_grace_days: 1 })).status).toBe(403);
    }
    expect((await api().get(URL)).status).toBe(401);
  });

  test('abonnement échu : lecture permise, modification 402', async () => {
    const p = await nouveauProprietaire();
    await expirerAbonnement(p.ownerId);
    expect((await api().get(URL).set(p.h)).status).toBe(200);
    expect((await api().patch(URL).set(p.h).send({ late_grace_days: 1 })).status).toBe(402);
    expect((await api().patch(`${URL}/profil`).set(p.h).send({ city: 'Thiès' })).status).toBe(402);
  });
});
