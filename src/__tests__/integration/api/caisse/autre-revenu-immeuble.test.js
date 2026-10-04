'use strict';

const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, fermer, compter,
} = require('../../../setup/helpers.js');

/**
 * Audit #18 (FAIBLE) — « autre revenu » de caisse (§ 21) : l'appartement
 * indiqué doit appartenir à l'immeuble indiqué, sinon le revenu est compté
 * dans le mauvais immeuble des rapports (§ 26 par immeuble, rentabilité).
 */

describe('Caisse — autre revenu : cohérence immeuble / appartement', () => {
  let p;
  let immeubleA;
  let immeubleB;
  let appartA;
  let appartB;

  beforeAll(async () => {
    p = await nouveauProprietaire();
    immeubleA = await creerImmeuble(p);
    immeubleB = await creerImmeuble(p);
    appartA = await creerAppartement(p, immeubleA.id);
    appartB = await creerAppartement(p, immeubleB.id);
  });
  afterAll(fermer);

  const revenu = (surcharges) => api().post('/api/v1/caisse/autres-revenus').set(p.h).send({
    amount: 25000, method: 'especes', occurred_on: '2026-09-10', label: 'Location salle commune', ...surcharges,
  });

  test('appartement d’un AUTRE immeuble → 422 APPARTEMENT_HORS_IMMEUBLE, aucun mouvement créé', async () => {
    const avant = await compter('cash_movements', 'owner_id = :o', { o: p.ownerId });
    const res = await revenu({ building_id: immeubleA.id, apartment_id: appartB.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('APPARTEMENT_HORS_IMMEUBLE');
    expect(await compter('cash_movements', 'owner_id = :o', { o: p.ownerId })).toBe(avant);
  });

  test('appartement de l’immeuble indiqué → 201', async () => {
    const res = await revenu({ building_id: immeubleA.id, apartment_id: appartA.id });
    expect(res.status).toBe(201);
    expect(res.body.data.movement).toMatchObject({ building_id: immeubleA.id, apartment_id: appartA.id, category: 'autre_revenu' });
  });

  test('appartement seul : l’immeuble est déduit de l’appartement (rapports par immeuble justes)', async () => {
    const res = await revenu({ apartment_id: appartB.id });
    expect(res.status).toBe(201);
    expect(res.body.data.movement).toMatchObject({ building_id: immeubleB.id, apartment_id: appartB.id });
  });
});
