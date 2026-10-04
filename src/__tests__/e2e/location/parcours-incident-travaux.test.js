'use strict';

const {
  api, proprietaireEtLocataire, pngTest, compter, fermer, sequelize,
} = require('../../setup/helpers.js');

/**
 * PARCOURS E2E — workflow incident (§ 22, 23, 24, 18, 19, 20, 21, 25, 27, 54.1).
 *
 * 1 locataire signale (photo) → 2 propriétaire notifié → 3 analyse →
 * 4 création / validation des travaux → 5 artisan assigné, intervention →
 * 6 photos avant / pendant / après → 7 dépense enregistrée (caisse) →
 * 8 travail terminé : incident résolu, locataire notifié, historique complet.
 */
describe('E2E — du signalement à la clôture des travaux', () => {
  afterAll(fermer);

  test('parcours nominal complet', async () => {
    const { proprio: p, locataire: l, apartment, building } = await proprietaireEtLocataire();
    const png = await pngTest();

    // 1. Signalement par le locataire, avec photo.
    const inc = (await api().post('/api/v1/locataire/incidents').set(l.h).send({ category: 'fuite', title: 'Fuite plomberie', description: 'Fuite sous l’évier de la cuisine' })).body.data.incident;
    expect(inc).toMatchObject({ status: 'signale', apartment_id: apartment.id });
    expect((await api().post(`/api/v1/locataire/incidents/${inc.id}/pieces`).set(l.h).attach('fichier', png, 'fuite.png')).status).toBe(201);

    // 2. Notification du propriétaire (§ 23 étape 2).
    expect(await compter('notifications', "type = 'incident' AND user_id = :u", { u: p.user.id })).toBeGreaterThanOrEqual(1);

    // 3. Analyse ; 4. travaux créés depuis l'incident.
    expect((await api().post(`/api/v1/incidents/${inc.id}/analyser`).set(p.h).send({ note: 'Joint à changer' })).status).toBe(200);
    const creation = await api().post(`/api/v1/incidents/${inc.id}/travaux`).set(p.h).send({ priority: 'haute', estimated_amount: 90000 });
    expect(creation.status).toBe(201);
    const wo = creation.body.data.work_order;
    expect(wo.building_id).toBe(building.id);
    expect((await api().get(`/api/v1/incidents/${inc.id}`).set(p.h)).body.data.incident.status).toBe('travaux_planifies');

    // 5. Artisan assigné puis intervention.
    const artisan = (await api().post('/api/v1/artisans').set(p.h).send({ name: 'Mamadou Diop', trade: 'plombier', phone: '+221770000001' })).body.data;
    const artisanId = (artisan.contractor || Object.values(artisan)[0]).id;
    // « Artisan assigné » sans artisan : refusé (règle § 18, doublée d'un CHECK SQL).
    expect([409, 422]).toContain((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'artisan_assigne' })).status);
    expect((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'artisan_assigne', contractor_id: artisanId })).status).toBe(200);
    expect((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'en_cours' })).status).toBe(200);

    // 6. Photos avant / pendant / après (§ 19).
    for (const phase of ['avant', 'pendant', 'apres']) {
      expect((await api().post(`/api/v1/travaux/${wo.id}/photos`).set(p.h).field('phase', phase).attach('fichier', png, `${phase}.png`)).status).toBe(201);
    }

    // 7. Dépense liée (§ 20) → caisse (§ 41).
    const dep = await api().post(`/api/v1/travaux/${wo.id}/depenses`).set(p.h).send({ amount: 100000, method: 'especes', spent_on: '2026-09-24', description: 'Réparation plomberie' });
    expect(dep.status).toBe(201);
    const depense = dep.body.data.expense;
    expect(depense).toMatchObject({ building_id: building.id, apartment_id: apartment.id, contractor_id: artisanId });
    expect(await compter('cash_movements', "source_type = 'expense' AND source_id = :d AND direction = 'sortie' AND amount = 100000", { d: depense.id })).toBe(1);

    // 8. Terminé : incident résolu, locataire notifié, travail immuable.
    expect((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'termine', actual_amount: 100000 })).status).toBe(200);
    expect((await api().get(`/api/v1/incidents/${inc.id}`).set(p.h)).body.data.incident.status).toBe('resolu');
    expect(await compter('notifications', "type = 'travail_termine' AND user_id = :u", { u: l.user.id })).toBe(1);
    expect((await api().patch(`/api/v1/travaux/${wo.id}`).set(p.h).send({ title: 'Changé' })).status).toBe(409);
    const [historique] = await sequelize.query('SELECT to_status FROM work_order_events WHERE work_order_id = :w ORDER BY created_at', { replacements: { w: wo.id } });
    expect(historique.map((h) => h.to_status)).toEqual(expect.arrayContaining(['artisan_assigne', 'en_cours', 'termine']));

    // Détail : 3 photos, la dépense, l'artisan ; historique de l'artisan et de l'appartement.
    const detail = (await api().get(`/api/v1/travaux/${wo.id}`).set(p.h)).body.data.work_order;
    expect(Object.values(detail.photos).flat()).toHaveLength(3);
    const fiche = (await api().get(`/api/v1/artisans/${artisanId}`).set(p.h)).body.data;
    expect(JSON.stringify(fiche)).toMatch(wo.id);
    const hist = (await api().get(`/api/v1/appartements/${apartment.id}/historique`).set(p.h)).body.data.items.map((e) => e.type);
    expect(hist).toEqual(expect.arrayContaining(['incident', 'travaux', 'depense']));
    // Le locataire suit « Mes demandes ».
    expect((await api().get('/api/v1/locataire/incidents').set(l.h)).body.data.items[0].status).toBe('resolu');
  });

  test('échecs : transitions interdites, pièce jointe après clôture, incident d’un autre locataire', async () => {
    const a = await proprietaireEtLocataire();
    const b = await proprietaireEtLocataire();
    const inc = (await api().post('/api/v1/locataire/incidents').set(a.locataire.h).send({ category: 'porte', title: 'Porte', description: 'La porte ferme mal' })).body.data.incident;
    expect((await api().get(`/api/v1/locataire/incidents/${inc.id}`).set(b.locataire.h)).status).toBe(403);
    expect((await api().post(`/api/v1/incidents/${inc.id}/analyser`).set(b.proprio.h).send({})).status).toBe(403);
    expect((await api().post(`/api/v1/incidents/${inc.id}/rejeter`).set(a.proprio.h).send({ reason: 'Usure normale, à la charge du locataire' })).status).toBe(200);
    expect((await api().post(`/api/v1/incidents/${inc.id}/analyser`).set(a.proprio.h).send({})).status).toBe(409);
    expect((await api().post(`/api/v1/locataire/incidents/${inc.id}/pieces`).set(a.locataire.h).attach('fichier', await pngTest(), 'x.png')).status).toBe(409);
    const wo = (await api().post('/api/v1/travaux').set(a.proprio.h).send({ title: 'Peinture', category: 'peinture', building_id: a.building.id })).body.data.work_order;
    expect((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(a.proprio.h).send({ status: 'termine' })).status).toBe(409);
    expect((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(a.proprio.h).send({ status: 'annule' })).status).toBe(422);
  });
});
