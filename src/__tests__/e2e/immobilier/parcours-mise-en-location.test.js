'use strict';

const {
  api, bearer, MOT_DE_PASSE, telephoneUnique, emailUnique, pngTest, publierModeleBail, compter, fermer, sequelize,
} = require('../../setup/helpers.js');

/**
 * PARCOURS E2E — de l'inscription du propriétaire à la mise en location
 * (§ 5, 6, 7, 8, 9, 10, 52, 53).
 *
 * inscription → connexion par téléphone → immeuble → appartements → locataire
 * → invitation → activation du compte locataire → état des lieux d'entrée
 * (trame, saisie groupée, photo, soumission) → acceptation par le locataire
 * → activation du bail → contrat généré et partagé → échéances → tableau de
 * bord. Chaque étape vérifie la réponse ET l'état de la base.
 */
describe('E2E — mise en location complète', () => {
  afterAll(fermer);

  test('parcours nominal du propriétaire et du locataire', async () => {
    // 1. Inscription puis connexion par téléphone (format national).
    const tel = telephoneUnique();
    const email = emailUnique('balla');
    const inscription = await api().post('/api/v1/auth/inscription').send({
      first_name: 'Balla', last_name: 'Diop', phone: tel.replace('+221', ''), email,
      password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE,
    });
    expect(inscription.status).toBe(201);
    expect(inscription.body.data.user).toMatchObject({ role: 'proprietaire', phone: tel });
    const connexion = await api().post('/api/v1/auth/connexion').send({ identifiant: tel, password: MOT_DE_PASSE, device_name: 'Téléphone' });
    expect(connexion.status).toBe(200);
    const h = bearer(connexion.body.data.access_token);
    const compte = (await api().get('/api/v1/compte').set(h)).body.data;
    expect(compte.abonnement.abonnement.status).toBe('essai');

    // 2. Patrimoine : immeuble « Résidence Almadies » et 3 appartements.
    const immeuble = (await api().post('/api/v1/immeubles').set(h)
      .send({ name: 'Résidence Almadies', address: 'Route des Almadies', city: 'Dakar', floors_count: 3 })).body.data.building;
    const appartements = [];
    for (const [numero, loyer] of [['A07', 350000], ['A08', 300000], ['B01', 250000]]) {
      const r = await api().post('/api/v1/appartements').set(h).send({ building_id: immeuble.id, number: numero, type: 'f3', rent_amount: loyer, rooms_count: 3 });
      expect(r.status).toBe(201);
      appartements.push(r.body.data.apartment);
    }
    const detailImmeuble = (await api().get(`/api/v1/immeubles/${immeuble.id}`).set(h)).body.data.building;
    expect(detailImmeuble).toMatchObject({ apartments_count: 3, available_count: 3, occupied_count: 0 });

    // 3. Locataire + invitation (option A) ; le code est rendu au propriétaire.
    const locataire = (await api().post('/api/v1/locataires').set(h).send({
      first_name: 'Mamadou', last_name: 'Ndiaye', phone: telephoneUnique(), id_document_type: 'cni', id_document_number: '1 234 567 890 12', send_invitation: true,
    })).body.data;
    expect(locataire.invitation.code).toMatch(/^\d{8}$/);
    const [[chiffre]] = await sequelize.query('SELECT id_document_number FROM tenants WHERE id = :id', { replacements: { id: locataire.tenant.id } });
    expect(chiffre.id_document_number).toMatch(/^v1:/); // pièce d'identité chiffrée au repos (§ 32)

    // 4. Activation du compte locataire (option B, code + téléphone).
    const activation = await api().post('/api/v1/auth/locataire/activation').send({
      code: locataire.invitation.code, phone: locataire.tenant.phone, password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE,
    });
    expect(activation.status).toBe(201);
    const hl = bearer(activation.body.data.access_token);

    // 5. Bail en brouillon ; activation refusée sans état des lieux d'entrée (§ 52.4).
    const bail = (await api().post('/api/v1/baux').set(h).send({
      apartment_id: appartements[0].id, tenant_id: locataire.tenant.id, start_date: '2026-10-01', deposit_amount: 700000, due_day: 5,
    })).body.data.lease;
    expect(bail).toMatchObject({ status: 'brouillon', rent_amount: 350000, reference: expect.stringMatching(/^BAIL-\d{4}-\d{4}$/) });
    expect((await api().post(`/api/v1/baux/${bail.id}/activer`).set(h)).body.error.code).toBe('ETAT_DES_LIEUX_ENTREE_REQUIS');

    // 6. État des lieux d'entrée : trame selon le type, saisie groupée, photo, soumission.
    const edl = (await api().post('/api/v1/etats-des-lieux').set(h).send({ lease_id: bail.id, type: 'entree', parties_present: [{ name: 'Balla Diop', role: 'bailleur' }] })).body.data.inspection;
    const detailEdl = (await api().get(`/api/v1/etats-des-lieux/${edl.id}`).set(h)).body.data.inspection;
    const elements = detailEdl.rooms.flatMap((r) => r.items);
    expect(detailEdl.rooms.length).toBeGreaterThanOrEqual(4);
    const saisie = await api().put(`/api/v1/etats-des-lieux/${edl.id}/saisie`).set(h)
      .send({ items: elements.map((i, k) => ({ item_id: i.id, condition: k === 0 ? 'usage' : 'bon', comment: k === 0 ? 'Rayure légère' : null })) });
    expect(saisie.status).toBe(200);
    expect((await api().post(`/api/v1/etats-des-lieux/${edl.id}/elements/${elements[0].id}/photos`).set(h)
      .field('captured_at', '2026-09-30T10:00:00Z').attach('fichier', await pngTest(), 'mur.png')).status).toBe(201);
    expect((await api().patch(`/api/v1/etats-des-lieux/${edl.id}`).set(h).send({ water_meter: 1234.5, electricity_meter: 5678, keys_count: 3 })).status).toBe(200);
    expect((await api().post(`/api/v1/etats-des-lieux/${edl.id}/soumettre`).set(h)).status).toBe(200);

    // 7. Le locataire le voit dans son espace et l'accepte → verrouillé, PDF archivé.
    const vus = (await api().get('/api/v1/locataire/etats-des-lieux').set(hl)).body.data.items;
    expect(vus.map((x) => x.id)).toContain(edl.id);
    expect((await api().post(`/api/v1/locataire/etats-des-lieux/${edl.id}/accepter`).set(hl)).status).toBe(200);
    const [[verrou]] = await sequelize.query('SELECT status, locked_at, document_id FROM inspections WHERE id = :id', { replacements: { id: edl.id } });
    expect(verrou.status).toBe('accepte');
    expect(verrou.locked_at).not.toBeNull();
    expect(verrou.document_id).not.toBeNull();
    expect((await api().patch(`/api/v1/etats-des-lieux/${edl.id}`).set(h).send({ keys_count: 4 })).status).toBe(409);

    // 8. Activation : appartement occupé, échéances générées, caution attendue.
    const actif = await api().post(`/api/v1/baux/${bail.id}/activer`).set(h);
    expect(actif.status).toBe(200);
    expect(actif.body.data.avertissements).toEqual([]);
    const echeances = (await api().get(`/api/v1/echeances?lease_id=${bail.id}&tri=due_date`).set(h)).body.data;
    expect(echeances.pagination.total).toBe(13);
    expect(echeances.items[0]).toMatchObject({ label: 'Loyer octobre 2026', due_date: '2026-10-05', amount_due: 350000 });
    expect(await compter('deposits', "lease_id = :l AND status = 'attendue' AND amount_expected = 700000", { l: bail.id })).toBe(1);

    // 9. Contrat OHADA généré depuis le modèle publié, partagé et visible du locataire.
    await publierModeleBail('habitation');
    const contrat = await api().post(`/api/v1/baux/${bail.id}/contrats`).set(h).send({ special_clauses: 'Animaux interdits.' });
    expect(contrat.status).toBe(201);
    const fichier = await api().get(`/api/v1/documents/${contrat.body.data.document.id}/fichier`).set(hl);
    expect(fichier.status).toBe(200);
    expect(fichier.headers['content-type']).toBe('application/pdf');

    // 10. Accueil du locataire : son logement, sa prochaine échéance.
    const accueil = (await api().get('/api/v1/locataire/accueil').set(hl)).body.data.homes;
    expect(accueil).toHaveLength(1);
    expect(accueil[0].lease.apartment.number).toBe('A07');
    expect(accueil[0].next_schedule.label).toBe('Loyer octobre 2026');

    // 11. Tableau de bord du propriétaire (§ 6).
    const tableau = (await api().get('/api/v1/dashboard?mois=2026-10').set(h)).body.data.dashboard;
    expect(tableau.patrimoine).toMatchObject({ immeubles: 1, appartements: 3, occupes: 1, disponibles: 2 });
    expect(tableau.loyers.a_recevoir).toBe(350000);

    // 12. Journal d'audit : chaque étape sensible est tracée (§ 40).
    const [actions] = await sequelize.query('SELECT DISTINCT action FROM audit_logs WHERE owner_id = (SELECT owner_id FROM leases WHERE id = :l)', { replacements: { l: bail.id } });
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining([
      'compte.creation', 'immeuble.creation', 'appartement.creation', 'locataire.creation', 'bail.creation', 'bail.changement_statut', 'bail.generation_contrat',
    ]));
  });

  test('scénarios d’échec du parcours', async () => {
    const tel = telephoneUnique();
    const base = { first_name: 'A', last_name: 'B', phone: tel, email: emailUnique(), password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE };
    expect((await api().post('/api/v1/auth/inscription').send({ ...base, password: 'faible' })).status).toBe(422);
    expect((await api().post('/api/v1/auth/inscription').send(base)).status).toBe(201);
    expect((await api().post('/api/v1/auth/inscription').send({ ...base, email: emailUnique() })).status).toBe(409);
    const h = bearer((await api().post('/api/v1/auth/connexion').send({ identifiant: tel, password: MOT_DE_PASSE })).body.data.access_token);

    // Code d'invitation faux, téléphone qui ne correspond pas, invitation déjà utilisée.
    const loc = (await api().post('/api/v1/locataires').set(h).send({ first_name: 'X', last_name: 'Y', phone: telephoneUnique(), send_invitation: true })).body.data;
    const activer = (corps) => api().post('/api/v1/auth/locataire/activation').send({ password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE, ...corps });
    expect((await activer({ code: '00000000', phone: loc.tenant.phone })).status).toBe(400);
    expect((await activer({ code: loc.invitation.code, phone: telephoneUnique() })).status).toBe(400);
    expect((await activer({ code: loc.invitation.code, phone: loc.tenant.phone })).status).toBe(201);
    expect((await activer({ code: loc.invitation.code, phone: loc.tenant.phone })).status).toBe(400);

    // Bail sur un appartement inexistant, dates incohérentes.
    const im = (await api().post('/api/v1/immeubles').set(h).send({ name: 'I', address: 'x', city: 'Dakar' })).body.data.building;
    const ap = (await api().post('/api/v1/appartements').set(h).send({ building_id: im.id, number: '1', type: 'studio', rent_amount: 100000 })).body.data.apartment;
    expect((await api().post('/api/v1/baux').set(h).send({ apartment_id: '6f1c8a52-7d2e-4f4b-9a3c-0b1d2e3f4a5b', tenant_id: loc.tenant.id, start_date: '2026-10-01' })).status).toBe(422);
    expect((await api().post('/api/v1/baux').set(h).send({ apartment_id: ap.id, tenant_id: loc.tenant.id, start_date: '2026-10-01', end_date: '2026-09-01' })).status).toBe(422);
    // Contrat impossible tant que le modèle n'est pas publié et validé juridiquement.
    // Les modèles sont des données PLATEFORME partagées par tous les fichiers du
    // worker (ordre aléatoire) : l'état « aucun modèle publié » est posé ici,
    // puis l'état antérieur exactement rétabli.
    const [publies] = await sequelize.query("UPDATE lease_templates SET status = 'brouillon' WHERE lease_type = 'professionnel' AND status = 'publie' RETURNING id");
    try {
      const b = (await api().post('/api/v1/baux').set(h).send({ apartment_id: ap.id, tenant_id: loc.tenant.id, start_date: '2026-10-01', lease_type: 'professionnel' })).body.data.lease;
      expect((await api().post(`/api/v1/baux/${b.id}/contrats`).set(h).send({})).body.error.code).toBe('MODELE_NON_PUBLIE');
    } finally {
      if (publies.length) await sequelize.query("UPDATE lease_templates SET status = 'publie' WHERE id IN (:ids)", { replacements: { ids: publies.map((l) => l.id) } });
    }
  });
});
