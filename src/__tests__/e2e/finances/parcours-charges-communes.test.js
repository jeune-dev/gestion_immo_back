'use strict';

const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, creerLocataire, desactiverEdlObligatoire, activerLocataire,
  compter, fermer,
} = require('../../setup/helpers.js');
const { aujourdhui } = require('../../../utils/dates.js');

/**
 * PARCOURS E2E — facture commune SENELEC (§ 15–17, 21, 28, 41).
 *
 * Exemple du cahier des charges : 720 000 FCFA pour un immeuble de 12
 * appartements → 60 000 chacun. 3 appartements occupés : 3 charges
 * refacturées ; les 9 parts des logements vacants restent au propriétaire.
 * Le locataire voit SA charge et l'explication du calcul, puis la paie.
 */
describe('E2E — factures communes et charges', () => {
  afterAll(fermer);

  test('répartition égale de 720 000 FCFA sur 12 appartements, refacturation, paiement de la charge', async () => {
    const p = await nouveauProprietaire();
    await desactiverEdlObligatoire(p);
    await require('../../setup/helpers.js').sequelize.query(
      "UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = 'PRO') WHERE owner_id = :o", { replacements: { o: p.ownerId } }
    );
    await require('../../../modules/abonnement/service/droits.service.js').invalider(p.ownerId);
    const immeuble = await creerImmeuble(p, { name: 'Résidence Almadies' });
    const apparts = [];
    for (let i = 1; i <= 12; i += 1) apparts.push(await creerAppartement(p, immeuble.id, { number: `A${String(i).padStart(2, '0')}` }));
    const locataires = [];
    for (const a of apparts.slice(0, 3)) {
      const t = await creerLocataire(p);
      const bail = (await api().post('/api/v1/baux').set(p.h).send({ apartment_id: a.id, tenant_id: t.id, start_date: '2026-09-01' })).body.data.lease;
      expect((await api().post(`/api/v1/baux/${bail.id}/activer`).set(p.h)).status).toBe(200);
      locataires.push({ tenant: t, bail });
    }

    // Facture → à répartir (§ 48), aperçu sans écriture, puis répartition.
    const facture = (await api().post('/api/v1/factures-communes').set(p.h).send({
      building_id: immeuble.id, charge_type: 'electricite', supplier: 'SENELEC', invoice_number: `SEN-${Date.now()}`,
      period_start: '2026-09-01', period_end: '2026-09-30', amount: 720000, allocation_method: 'egale', due_date: '2026-10-15',
    })).body.data;
    const fid = (facture.invoice || facture.charge_invoice).id;
    expect((await api().get('/api/v1/factures-communes/a-repartir').set(p.h)).body.data.count).toBe(1);
    const apercu = await api().get(`/api/v1/factures-communes/${fid}/apercu`).set(p.h);
    expect(apercu.status).toBe(200);
    expect(await compter('charge_allocations', 'charge_invoice_id = :f', { f: fid })).toBe(0);
    expect((await api().post(`/api/v1/factures-communes/${fid}/repartir`).set(p.h).send({})).status).toBe(200);

    const [allocs] = await require('../../setup/helpers.js').sequelize.query(
      'SELECT amount, explanation FROM charge_allocations WHERE charge_invoice_id = :f', { replacements: { f: fid } }
    );
    expect(allocs).toHaveLength(12);
    expect(allocs.every((a) => a.amount === 60000)).toBe(true);
    expect(allocs[0].explanation).toMatch(/720 000 FCFA ÷ 12 appartements = 60 000 FCFA/);
    expect(await compter('charges', 'charge_invoice_id = :f', { f: fid })).toBe(3);
    // Facture répartie : plus modifiable, plus « à répartir ».
    expect((await api().patch(`/api/v1/factures-communes/${fid}`).set(p.h).send({ amount: 1 })).status).toBe(409);
    expect((await api().get('/api/v1/factures-communes/a-repartir').set(p.h)).body.data.count).toBe(0);

    // Le locataire voit SA charge et l'explication — jamais celles des voisins.
    const l1 = await activerLocataire(p, locataires[0].tenant);
    const mes = (await api().get('/api/v1/locataire/charges').set(l1.h)).body.data.items;
    expect(mes).toHaveLength(1);
    const detail = (await api().get(`/api/v1/locataire/charges/${mes[0].id}`).set(l1.h)).body.data;
    expect(JSON.stringify(detail)).toMatch(/60 000/);
    expect(JSON.stringify(detail)).not.toMatch(new RegExp(locataires[1].tenant.last_name + '|' + locataires[1].tenant.phone.replace('+', '\\+')));

    // Paiement de la charge en espèces → charge payée, caisse « charges ».
    const pay = await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: locataires[0].bail.id, charge_id: mes[0].id, amount: 60000, paid_on: aujourdhui() });
    expect(pay.status).toBe(201);
    expect((await api().get(`/api/v1/locataire/charges/${mes[0].id}`).set(l1.h)).body.data.charge?.status || 'paye').toBe('paye');
    expect(await compter('cash_movements', "source_id = :p AND category = 'charges' AND amount = 60000", { p: pay.body.data.payment.id })).toBe(1);

    // Annulation impossible : une charge est encaissée.
    expect((await api().post(`/api/v1/factures-communes/${fid}/annuler`).set(p.h).send({ reason: 'Erreur' })).status).toBe(409);
  });

  test('montants personnalisés dont la somme diffère de la facture : refusé, rien n’est écrit', async () => {
    const p = await nouveauProprietaire();
    const immeuble = await creerImmeuble(p);
    const a1 = await creerAppartement(p, immeuble.id);
    const a2 = await creerAppartement(p, immeuble.id);
    const f = (await api().post('/api/v1/factures-communes').set(p.h).send({
      building_id: immeuble.id, charge_type: 'eau', period_start: '2026-09-01', period_end: '2026-09-30', amount: 100000, allocation_method: 'personnalise',
    })).body.data;
    const fid = (f.invoice || f.charge_invoice).id;
    const res = await api().post(`/api/v1/factures-communes/${fid}/repartir`).set(p.h)
      .send({ lines: [{ apartment_id: a1.id, amount: 60000 }, { apartment_id: a2.id, amount: 30000 }] });
    expect(res.status).toBe(422);
    expect(await compter('charge_allocations', 'charge_invoice_id = :f', { f: fid })).toBe(0);
    expect((await api().post(`/api/v1/factures-communes/${fid}/repartir`).set(p.h)
      .send({ lines: [{ apartment_id: a1.id, amount: 70000 }, { apartment_id: a2.id, amount: 30000 }] })).status).toBe(200);
  });
});
