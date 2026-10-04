'use strict';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, creerLocataire, desactiverEdlObligatoire,
  activerLocataire, fermer, sequelize,
} = require('../../../setup/helpers.js');
const auth = require('../../../../middlewares/auth.middleware.js');
const { requireLocataire } = require('../../../../middlewares/acces.middleware.js');
const errorHandler = require('../../../../middlewares/errorHandler.middleware.js');
const { mettreAJourStatutsCharges, statutCharge } = require('../../../../modules/charge/service/charge.service.js');
const { aujourdhui } = require('../../../../utils/dates.js');

/**
 * § 15–17 Charges : factures communes, répartition explicable, charges
 * refacturées aux seuls appartements occupés ; § 28 « Mes charges » (le
 * locataire ne voit que SA part) ; § 32/§ 43 accès horizontal (403).
 */

// Le routeur locataire est monté par l'espace locataire (hors de ce module) :
// on le monte ici derrière les MÊMES gardes (auth → requireLocataire).
const appLocataire = express();
appLocataire.use(express.json());
appLocataire.use('/api/v1/locataire/charges', auth, requireLocataire, require('../../../../modules/charge/route/chargeLocataire.route.js'));
appLocataire.use(errorHandler);
const apiLocataire = () => request(appLocataire);

jest.setTimeout(60000);

const FC = '/api/v1/factures-communes';
const uuidInconnu = () => crypto.randomUUID();

async function nouveauBail(proprio, apartment, tenant, surcharges = {}) {
  const creation = await api().post('/api/v1/baux').set(proprio.h).send({
    apartment_id: apartment.id, tenant_id: tenant.id, start_date: '2026-09-01',
    rent_amount: apartment.rent_amount, deposit_amount: 0, due_day: 5, ...surcharges,
  });
  if (creation.status !== 201) throw new Error(`Bail : ${creation.status} ${JSON.stringify(creation.body)}`);
  const activation = await api().post(`/api/v1/baux/${creation.body.data.lease.id}/activer`).set(proprio.h).send({});
  if (activation.status !== 200) throw new Error(`Activation : ${activation.status} ${JSON.stringify(activation.body)}`);
  return activation.body.data.lease;
}

describe('Charges — factures communes et répartition', () => {
  let proprio;
  let autreProprio;
  let immeuble;
  let appartements; // A01 … A12
  let autreImmeuble;
  let appartAutreImmeuble;
  let appartAutreProprio;
  let locataires; // occupants de A01, A02, A03
  let comptes; // sessions des locataires de A01 et A02

  const facture = (surcharges = {}) => api().post(FC).set(proprio.h).send({
    building_id: immeuble.id, charge_type: 'electricite', supplier: 'SENELEC',
    invoice_number: `F-${crypto.randomBytes(4).toString('hex')}`,
    period_start: '2026-09-01', period_end: '2026-09-30', amount: 720000,
    due_date: '2026-10-15', allocation_method: 'egale', ...surcharges,
  });

  beforeAll(async () => {
    proprio = await nouveauProprietaire();
    autreProprio = await nouveauProprietaire();
    await desactiverEdlObligatoire(proprio);
    immeuble = await creerImmeuble(proprio, { name: 'Résidence Almadies' });
    appartements = [];
    for (let i = 1; i <= 12; i += 1) {
      appartements.push(await creerAppartement(proprio, immeuble.id, {
        number: `A${String(i).padStart(2, '0')}`, charge_coefficient: i <= 2 ? 2 : 1,
      }));
    }
    autreImmeuble = await creerImmeuble(proprio);
    appartAutreImmeuble = await creerAppartement(proprio, autreImmeuble.id);
    const immeubleB = await creerImmeuble(autreProprio);
    appartAutreProprio = await creerAppartement(autreProprio, immeubleB.id);

    locataires = [];
    for (const [i, occupants] of [[0, 2], [1, 3], [2, 1]]) {
      const tenant = await creerLocataire(proprio);
      await nouveauBail(proprio, appartements[i], tenant, { occupants_count: occupants });
      locataires.push(tenant);
    }
    comptes = [await activerLocataire(proprio, locataires[0]), await activerLocataire(proprio, locataires[1])];
  }, 120000);

  afterAll(fermer);

  test('§ 16 : SENELEC 720 000 FCFA sur 12 appartements → 12 × 60 000 ; charges pour les 3 occupés seulement', async () => {
    const creation = await facture();
    expect(creation.status).toBe(201);
    const inv = creation.body.data.invoice;
    expect(inv.status).toBe('brouillon');

    // Aperçu : calcul complet, rien d'enregistré.
    const apercu = await api().get(`${FC}/${inv.id}/apercu`).set(proprio.h);
    expect(apercu.status).toBe(200);
    const calcul = apercu.body.data.allocation;
    expect(calcul.lines).toHaveLength(12);
    expect(calcul.lines.every((l) => l.amount === 60000)).toBe(true);
    expect(calcul.lines[0]).toMatchObject({ apartment_number: 'A01', explanation: '720 000 FCFA ÷ 12 appartements = 60 000 FCFA', recharged: true });
    expect(calcul.recharged_total).toBe(180000);
    expect(calcul.owner_share).toBe(540000);
    const apres = await api().get(`${FC}/${inv.id}`).set(proprio.h);
    expect(apres.body.data.invoice).toMatchObject({ status: 'brouillon', allocations_count: 0 });

    // § 48 « Quelle facture dois-je répartir ? »
    const aRepartir = await api().get(`${FC}/a-repartir`).set(proprio.h);
    expect(aRepartir.status).toBe(200);
    expect(aRepartir.body.data.invoices.map((f) => f.id)).toContain(inv.id);
    const brouillons = await api().get(`${FC}?status=brouillon`).set(proprio.h);
    expect(brouillons.body.data.items.map((f) => f.id)).toContain(inv.id);

    const rep = await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({});
    expect(rep.status).toBe(200);
    const detail = rep.body.data.invoice;
    expect(detail.status).toBe('repartie');
    expect(detail.allocated_at).toBeTruthy();
    expect(detail.allocations).toHaveLength(12);
    expect(detail.allocations.map((a) => a.amount)).toEqual(Array(12).fill(60000));
    expect(detail.allocations_total).toBe(720000);
    expect(detail.allocations.map((a) => a.apartment.number)).toEqual(appartements.map((a) => a.number));
    expect(Number(detail.allocations[0].share)).toBeCloseTo(1 / 12, 8);

    // Occupés : charge refacturée ; vacants : part au propriétaire (lease_id NULL, aucune charge).
    const occupes = detail.allocations.slice(0, 3);
    const vacants = detail.allocations.slice(3);
    expect(occupes.every((a) => a.lease_id && a.charge && a.charge.amount === 60000)).toBe(true);
    expect(occupes[0].lease.tenant.last_name).toBe(locataires[0].last_name);
    expect(vacants.every((a) => a.lease_id === null && a.charge === null)).toBe(true);
    expect(detail.recharged_total).toBe(180000);

    const [charges] = await sequelize.query('SELECT * FROM charges WHERE charge_invoice_id = :id ORDER BY amount', { replacements: { id: inv.id } });
    expect(charges).toHaveLength(3);
    const statutAttendu = statutCharge({ amount: 60000, amount_paid: 0, due_date: '2026-10-15' }, aujourdhui());
    for (const c of charges) {
      expect(c).toMatchObject({ label: 'Électricité septembre 2026 — SENELEC', amount: 60000, due_date: '2026-10-15', status: statutAttendu, charge_type: 'electricite' });
    }

    // Une notification « facture » par locataire (le locataire de A01 a un compte).
    const [notifs] = await sequelize.query(
      "SELECT * FROM notifications WHERE user_id = :u AND type = 'facture' AND data->>'charge_invoice_id' = :id",
      { replacements: { u: comptes[0].user.id, id: inv.id } }
    );
    expect(notifs).toHaveLength(1);

    // Journal d'audit dans la même transaction.
    const [audit] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'facture_commune.repartition' AND entity_id = :id", { replacements: { id: inv.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ methode: 'egale', montant: 720000, charges_creees: 3, refacture: 180000 });

    // Facture répartie : ni modifiable ni répartissable à nouveau (409).
    expect((await api().patch(`${FC}/${inv.id}`).set(proprio.h).send({ amount: 700000 })).status).toBe(409);
    expect((await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({})).status).toBe(409);
    expect((await api().get(`${FC}/${inv.id}/apercu`).set(proprio.h)).status).toBe(409);
  });

  test("méthode « occupants » : bail actif sur la période ; vacant → 0 FCFA", async () => {
    const inv = (await facture({ amount: 60000, allocation_method: 'occupants', charge_type: 'eau', supplier: 'SEN’EAU' })).body.data.invoice;
    const rep = await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({});
    expect(rep.status).toBe(200);
    const lignes = rep.body.data.invoice.allocations;
    expect(lignes.slice(0, 3).map((a) => a.amount)).toEqual([20000, 30000, 10000]);
    expect(lignes.slice(3).every((a) => a.amount === 0)).toBe(true);
    expect(lignes[1].explanation).toBe('3 occupants sur 6 au total (50,00 %) de 60 000 FCFA = 30 000 FCFA');
    expect(lignes[5].explanation).toMatch(/logement vacant/);
    expect(lignes.reduce((s, a) => s + a.amount, 0)).toBe(60000);

    // Aucun occupant parmi les appartements retenus → 422.
    const vide = (await facture({ amount: 60000, allocation_method: 'occupants' })).body.data.invoice;
    const r = await api().post(`${FC}/${vide.id}/repartir`).set(proprio.h).send({ apartment_ids: [appartements[5].id, appartements[6].id] });
    expect(r.status).toBe(422);
  });

  test('montant personnalisé : somme différente du total → 422 ; exacte → répartie', async () => {
    const inv = (await facture({ amount: 100000, allocation_method: 'personnalise' })).body.data.invoice;
    const lignes = [
      { apartment_id: appartements[0].id, amount: 40000 },
      { apartment_id: appartements[1].id, amount: 59999 },
    ];
    const faux = await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({ lines: lignes });
    expect(faux.status).toBe(422);
    expect(faux.body.error.code).toBe('SOMME_DIFFERENTE_DU_TOTAL');
    expect((await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({})).status).toBe(422);

    lignes[1].amount = 60000;
    const ok = await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({ lines: lignes });
    expect(ok.status).toBe(200);
    expect(ok.body.data.invoice.allocations.map((a) => a.amount)).toEqual([40000, 60000]);
  });

  test('consommation (aperçu GET avec lignes JSON) et coefficient (tantièmes des appartements)', async () => {
    const inv = (await facture({ allocation_method: 'consommation' })).body.data.invoice;
    const lignes = [
      { apartment_id: appartements[0].id, consumption: 34.5 },
      { apartment_id: appartements[1].id, consumption: 375.5 },
    ];
    const apercu = await api().get(`${FC}/${inv.id}/apercu`).query({ lines: JSON.stringify(lignes) }).set(proprio.h);
    expect(apercu.status).toBe(200);
    expect(apercu.body.data.allocation.lines[0]).toMatchObject({
      amount: 60585, explanation: '34,5 kWh sur 410 kWh (8,41 %) de 720 000 FCFA = 60 585 FCFA',
    });
    expect(apercu.body.data.allocation.lines.reduce((s, l) => s + l.amount, 0)).toBe(720000);

    const coef = (await facture({ amount: 140000, allocation_method: 'coefficient', charge_type: 'gardiennage' })).body.data.invoice;
    const rep = await api().post(`${FC}/${coef.id}/repartir`).set(proprio.h).send({});
    expect(rep.status).toBe(200);
    // Coefficients : 2 + 2 + 10 × 1 = 14 → 20 000, 20 000, puis 10 × 10 000.
    expect(rep.body.data.invoice.allocations.map((a) => a.amount)).toEqual([20000, 20000, ...Array(10).fill(10000)]);
  });

  test("appartement d'un autre immeuble → 422 ; d'un autre propriétaire → 403", async () => {
    const inv = (await facture()).body.data.invoice;
    const horsImmeuble = await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h)
      .send({ apartment_ids: [appartements[0].id, appartAutreImmeuble.id] });
    expect(horsImmeuble.status).toBe(422);
    expect(horsImmeuble.body.error.code).toBe('APPARTEMENT_HORS_IMMEUBLE');
    const autre = await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h)
      .send({ apartment_ids: [appartements[0].id, appartAutreProprio.id] });
    expect(autre.status).toBe(403);
    const inconnu = await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({ apartment_ids: [uuidInconnu()] });
    expect(inconnu.status).toBe(422);
    // Rien n'a été écrit : la facture est toujours à répartir.
    const detail = await api().get(`${FC}/${inv.id}`).set(proprio.h);
    expect(detail.body.data.invoice).toMatchObject({ status: 'brouillon', allocations_count: 0 });

    // Sous-ensemble explicite : 720 000 / 2.
    const sub = await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({ apartment_ids: [appartements[3].id, appartements[4].id] });
    expect(sub.status).toBe(200);
    expect(sub.body.data.invoice.allocations.map((a) => a.amount)).toEqual([360000, 360000]);
  });

  test('accès : autre propriétaire → 403, absente → 404, validation → 422', async () => {
    const inv = (await facture()).body.data.invoice;
    expect((await api().get(`${FC}/${inv.id}`).set(autreProprio.h)).status).toBe(403);
    expect((await api().patch(`${FC}/${inv.id}`).set(autreProprio.h).send({ amount: 1 })).status).toBe(403);
    expect((await api().post(`${FC}/${inv.id}/repartir`).set(autreProprio.h).send({})).status).toBe(403);
    expect((await api().get(`${FC}/${uuidInconnu()}`).set(proprio.h)).status).toBe(404);
    // Immeuble d'un autre propriétaire.
    const creation = await api().post(FC).set(autreProprio.h).send({
      building_id: immeuble.id, charge_type: 'eau', period_start: '2026-09-01', period_end: '2026-09-30', amount: 1000, allocation_method: 'egale',
    });
    expect(creation.status).toBe(403);
    // § 41 : méthode de répartition obligatoire ; période incohérente.
    const sansMethode = await api().post(FC).set(proprio.h).send({
      building_id: immeuble.id, charge_type: 'eau', period_start: '2026-09-01', period_end: '2026-09-30', amount: 1000,
    });
    expect(sansMethode.status).toBe(422);
    expect((await facture({ period_end: '2026-08-01' })).status).toBe(422);
    expect((await facture({ amount: 0 })).status).toBe(422);
    // La liste de l'autre propriétaire ne contient pas nos factures.
    const liste = await api().get(FC).set(autreProprio.h);
    expect(liste.body.data.items.map((f) => f.id)).not.toContain(inv.id);
  });

  test('modification en brouillon, justificatif, annulation (brouillon puis répartie)', async () => {
    const inv = (await facture({ amount: 120000 })).body.data.invoice;
    const modif = await api().patch(`${FC}/${inv.id}`).set(proprio.h).send({ amount: 240000, notes: 'Relevé corrigé' });
    expect(modif.status).toBe(200);
    expect(modif.body.data.invoice.amount).toBe(240000);

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const doc = await api().post(`${FC}/${inv.id}/document`).set(proprio.h).attach('fichier', pdf, 'senelec.pdf');
    expect(doc.status).toBe(201);
    expect(doc.body.data.document.category).toBe('facture');
    const detail = await api().get(`${FC}/${inv.id}`).set(proprio.h);
    expect(detail.body.data.invoice.documents).toHaveLength(1);

    const brouillon = (await facture()).body.data.invoice;
    const a1 = await api().post(`${FC}/${brouillon.id}/annuler`).set(proprio.h).send({ reason: 'Saisie en double' });
    expect(a1.status).toBe(200);
    expect(a1.body.data.invoice.status).toBe('annulee');
    expect((await api().post(`${FC}/${brouillon.id}/annuler`).set(proprio.h).send({ reason: 'Encore' })).status).toBe(409);
    expect((await api().post(`${FC}/${brouillon.id}/repartir`).set(proprio.h).send({})).status).toBe(409);

    // Répartie sans encaissement : les charges générées sont annulées.
    await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({});
    const a2 = await api().post(`${FC}/${inv.id}/annuler`).set(proprio.h).send({ reason: 'Facture contestée auprès de SENELEC' });
    expect(a2.status).toBe(200);
    const [statuts] = await sequelize.query('SELECT DISTINCT status FROM charges WHERE charge_invoice_id = :id', { replacements: { id: inv.id } });
    expect(statuts.map((s) => s.status)).toEqual(['annule']);

    // Répartie avec une charge déjà encaissée : annulation refusée.
    const payee = (await facture()).body.data.invoice;
    await api().post(`${FC}/${payee.id}/repartir`).set(proprio.h).send({});
    await sequelize.query(
      "UPDATE charges SET amount_paid = 1000, status = 'partiellement_paye' WHERE id = (SELECT id FROM charges WHERE charge_invoice_id = :id LIMIT 1)",
      { replacements: { id: payee.id } }
    );
    const refus = await api().post(`${FC}/${payee.id}/annuler`).set(proprio.h).send({ reason: 'Erreur de saisie' });
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('CHARGE_ENCAISSEE');
  });

  test('charges côté propriétaire : liste filtrée et détail avec explication', async () => {
    const liste = await api().get('/api/v1/charges').query({ building_id: immeuble.id, tenant_id: locataires[0].id }).set(proprio.h);
    expect(liste.status).toBe(200);
    expect(liste.body.data.items.length).toBeGreaterThan(0);
    expect(liste.body.data.items.every((c) => c.tenant.id === locataires[0].id && c.apartment.building.name === 'Résidence Almadies')).toBe(true);

    const id = liste.body.data.items[0].id;
    const detail = await api().get(`/api/v1/charges/${id}`).set(proprio.h);
    expect(detail.status).toBe(200);
    expect(detail.body.data.charge.allocation.explanation).toBeTruthy();
    expect((await api().get(`/api/v1/charges/${id}`).set(autreProprio.h)).status).toBe(403);
    const autreListe = await api().get('/api/v1/charges').set(autreProprio.h);
    expect(autreListe.body.data.items).toHaveLength(0);
  });

  test('§ 28 « Mes charges » : le locataire ne voit que SA part, avec l’explication du calcul', async () => {
    const inv = (await facture({ invoice_number: 'SEN-2026-09-A' })).body.data.invoice;
    await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({});

    const liste = await apiLocataire().get('/api/v1/locataire/charges').set(comptes[0].h);
    expect(liste.status).toBe(200);
    const [maCharge] = await sequelize.query(
      'SELECT id FROM charges WHERE charge_invoice_id = :id AND tenant_id = :t', { replacements: { id: inv.id, t: locataires[0].id } }
    );
    expect(liste.body.data.items.map((c) => c.id)).toContain(maCharge[0].id);
    const [nbSiennes] = await sequelize.query('SELECT count(*)::int AS n FROM charges WHERE tenant_id = :t', { replacements: { t: locataires[0].id } });
    expect(liste.body.data.pagination.total).toBe(nbSiennes[0].n);

    const detail = await apiLocataire().get(`/api/v1/locataire/charges/${maCharge[0].id}`).set(comptes[0].h);
    expect(detail.status).toBe(200);
    const c = detail.body.data.charge;
    expect(c).toMatchObject({ amount: 60000, remaining: 60000, apartment: { number: 'A01' } });
    expect(c.calculation).toMatchObject({
      method: 'egale', invoice_total: 720000, apartments_count: 12, supplier: 'SENELEC',
      explanation: '720 000 FCFA ÷ 12 appartements = 60 000 FCFA',
    });
    // Jamais les autres locataires ni les autres appartements.
    const brut = JSON.stringify(detail.body);
    for (const autre of locataires.slice(1)) {
      expect(brut).not.toContain(autre.phone);
      expect(brut).not.toContain(autre.id);
    }
    expect(brut).not.toMatch(/"A0[2-9]"|"A1[0-2]"/);
    expect(brut).not.toContain('allocations');

    // Un autre locataire → 403 ; un propriétaire n'entre pas dans l'espace locataire.
    const intrus = await apiLocataire().get(`/api/v1/locataire/charges/${maCharge[0].id}`).set(comptes[1].h);
    expect(intrus.status).toBe(403);
    expect((await apiLocataire().get('/api/v1/locataire/charges').set(proprio.h)).status).toBe(403);
    expect((await apiLocataire().get(`/api/v1/locataire/charges/${uuidInconnu()}`).set(comptes[0].h)).status).toBe(404);
  });

  test('job quotidien : charges échues non soldées → en_retard (partiellement payées comprises)', async () => {
    const inv = (await facture({ due_date: '2026-10-05' })).body.data.invoice;
    await api().post(`${FC}/${inv.id}/repartir`).set(proprio.h).send({});
    const [lignes] = await sequelize.query('SELECT id FROM charges WHERE charge_invoice_id = :id ORDER BY apartment_id', { replacements: { id: inv.id } });
    const [partielle, soldee, simple] = lignes.map((l) => l.id);
    await sequelize.query("UPDATE charges SET amount_paid = 10000, status = 'partiellement_paye' WHERE id = :id", { replacements: { id: partielle } });
    await sequelize.query("UPDATE charges SET amount_paid = amount, status = 'paye', paid_at = now() WHERE id = :id", { replacements: { id: soldee } });
    await sequelize.query("UPDATE charges SET status = 'a_payer' WHERE id = :id", { replacements: { id: simple } });

    // Avant l'échéance : rien ne passe en retard.
    await mettreAJourStatutsCharges('2026-10-05');
    const [avant] = await sequelize.query('SELECT id, status FROM charges WHERE id IN (:ids)', { replacements: { ids: lignes.map((l) => l.id) } });
    expect(Object.fromEntries(avant.map((l) => [l.id, l.status]))).toEqual({ [partielle]: 'partiellement_paye', [soldee]: 'paye', [simple]: 'a_payer' });

    const modifiees = await mettreAJourStatutsCharges('2026-10-06');
    expect(modifiees).toBeGreaterThanOrEqual(2);
    const [apres] = await sequelize.query('SELECT id, status FROM charges WHERE id IN (:ids)', { replacements: { ids: lignes.map((l) => l.id) } });
    expect(Object.fromEntries(apres.map((l) => [l.id, l.status]))).toEqual({ [partielle]: 'en_retard', [soldee]: 'paye', [simple]: 'en_retard' });
    // Les charges annulées ne sont jamais touchées.
    const [annulees] = await sequelize.query("SELECT count(*)::int AS n FROM charges WHERE cancelled_at IS NOT NULL AND status <> 'annule'");
    expect(annulees[0].n).toBe(0);
  });
});
