'use strict';

const {
  api, nouveauProprietaire, superAdmin, compter, fermer, sequelize,
} = require('../../setup/helpers.js');

/**
 * PARCOURS E2E — Super Admin web (§ 29, 30, 31, 53.4).
 *
 * tableau de bord plateforme → tarif d'un plan modifié (visible au public)
 * → abonnement expiré (job) : propriétaire en lecture seule → activation
 * manuelle : écritures rétablies → suspension d'un propriétaire : accès coupé
 * → réactivation → nouvelle version de modèle de bail publiée (l'ancienne
 * archivée) → notification diffusée → journal d'audit.
 */
describe('E2E — administration de la plateforme', () => {
  afterAll(fermer);

  test('parcours nominal', async () => {
    const admin = await superAdmin();
    const p = await nouveauProprietaire();

    // Tableau de bord (§ 29).
    const tb = (await api().get('/api/v1/admin/dashboard').set(admin.h)).body.data;
    expect(JSON.stringify(tb)).toMatch(/proprietaires|owners/);

    // Tarif configurable, jamais codé en dur (§ 31).
    const plans = (await api().get('/api/v1/admin/plans').set(admin.h)).body.data;
    const starter = (plans.items || plans.plans).find((x) => x.code === 'STARTER');
    expect((await api().patch(`/api/v1/admin/plans/${starter.id}`).set(admin.h).send({ price: 6000 })).status).toBe(200);
    const publics = (await api().get('/api/v1/abonnement/plans')).body.data.plans;
    expect(publics.find((x) => x.code === 'STARTER').price).toBe(6000);
    await api().patch(`/api/v1/admin/plans/${starter.id}`).set(admin.h).send({ price: 5000 });

    // Expiration par le job → lecture seule (402) ; activation manuelle → écritures OK.
    await sequelize.query("UPDATE subscriptions SET current_period_start = '2026-01-01', current_period_end = '2026-02-01' WHERE owner_id = :o", { replacements: { o: p.ownerId } });
    const { expirerAbonnements } = require('../../../modules/abonnement/service/abonnement.service.js');
    expect(await expirerAbonnements()).toBeGreaterThanOrEqual(1);
    expect((await api().get('/api/v1/immeubles').set(p.h)).status).toBe(200);
    expect((await api().post('/api/v1/immeubles').set(p.h).send({ name: 'Bloqué', address: 'x', city: 'Dakar' })).status).toBe(402);
    const activation = await api().post(`/api/v1/admin/proprietaires/${p.ownerId}/abonnement/activer`).set(admin.h)
      .send({ plan_code: 'BUSINESS', months: 1, note: 'Paiement reçu en agence' });
    expect(activation.status).toBe(201); // crée l'enregistrement de paiement manuel
    expect((await api().post('/api/v1/immeubles').set(p.h).send({ name: 'Débloqué', address: 'x', city: 'Dakar' })).status).toBe(201);

    // Suspension : tout accès propriétaire coupé, puis réactivation.
    expect((await api().post(`/api/v1/admin/proprietaires/${p.ownerId}/suspendre`).set(admin.h).send({ reason: 'Impayés répétés' })).status).toBe(200);
    const relog = await api().post('/api/v1/auth/connexion').send({ identifiant: p.identifiants.email, password: p.identifiants.password });
    expect((await api().get('/api/v1/immeubles').set({ Authorization: `Bearer ${relog.body.data.access_token}` })).body.error.code).toBe('ESPACE_SUSPENDU');
    expect((await api().post(`/api/v1/admin/proprietaires/${p.ownerId}/reactiver`).set(admin.h)).status).toBe(200);
    expect((await api().get('/api/v1/immeubles').set({ Authorization: `Bearer ${relog.body.data.access_token}` })).status).toBe(200);

    // Modèle de bail : nouvelle version publiée, précédente archivée, versions publiées immuables (§ 53.4).
    const [[v1]] = await sequelize.query("SELECT id, body FROM lease_templates WHERE lease_type = 'bail_inexistant' OR (lease_type = 'professionnel' AND version = 1)");
    await api().post(`/api/v1/admin/modeles-bail/${v1.id}/publier`).set(admin.h);
    const v2 = await api().post('/api/v1/admin/modeles-bail').set(admin.h)
      .send({ lease_type: 'professionnel', title: 'Bail professionnel v2', body: `${v1.body}\nArticle ajouté : {{bail.reference}}.`, legal_notes: 'Validé par Me X' });
    expect(v2.status).toBe(201);
    const idV2 = (v2.body.data.template || v2.body.data.lease_template || Object.values(v2.body.data)[0]).id;
    expect((await api().post(`/api/v1/admin/modeles-bail/${idV2}/publier`).set(admin.h)).status).toBe(200);
    const [types] = await sequelize.query("SELECT version, status FROM lease_templates WHERE lease_type = 'professionnel' ORDER BY version");
    expect(types.filter((t) => t.status === 'publie')).toHaveLength(1);
    expect(types.find((t) => t.version === 1).status).toBe('archive');
    expect((await api().patch(`/api/v1/admin/modeles-bail/${idV2}`).set(admin.h).send({ title: 'Titre modifié après publication' })).status).toBe(409);
    expect((await api().post('/api/v1/admin/modeles-bail').set(admin.h).send({ lease_type: 'professionnel', title: 't', body: '{{variable.inconnue}}' })).status).toBe(422);

    // Diffusion d'une notification à tous les propriétaires.
    expect((await api().post('/api/v1/admin/notifications').set(admin.h).send({ cible: 'proprietaires', titre: 'Maintenance', corps: 'Maintenance dimanche 2 h.' })).status).toBe(201);
    expect(await compter('notifications', "user_id = :u AND title = 'Maintenance'", { u: p.user.id })).toBe(1);

    // Journal d'audit filtrable.
    const journal = (await api().get(`/api/v1/admin/journal-audit?owner_id=${p.ownerId}`).set(admin.h)).body.data.items.map((l) => l.action);
    expect(journal.length).toBeGreaterThan(0);
  });

  test('échecs : un propriétaire ne peut rien faire en /admin, un admin ne peut pas se désactiver lui-même', async () => {
    const admin = await superAdmin();
    const p = await nouveauProprietaire();
    expect((await api().get('/api/v1/admin/dashboard').set(p.h)).status).toBe(403);
    expect((await api().post(`/api/v1/admin/proprietaires/${p.ownerId}/suspendre`).set(p.h).send({ reason: 'x' })).status).toBe(403);
    expect((await api().post(`/api/v1/admin/utilisateurs/${admin.user.id}/desactiver`).set(admin.h).send({ reason: 'test' })).status).toBe(409);
    expect((await api().put('/api/v1/admin/parametres/essai').set(admin.h).send({ plan_code: 'INEXISTANT', duree_jours: 14 })).status).toBe(422);
  });
});
