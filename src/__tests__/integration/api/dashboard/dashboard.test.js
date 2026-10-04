'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, bailActif, fermer, sequelize,
} = require('../../../setup/helpers.js');
const { aujourdhui, ajouterMois } = require('../../../../utils/dates.js');
const cache = require('../../../../utils/cache.js');

/**
 * § 6 tableau de bord, § 48 les sept questions, § 55.4 caution exclue des
 * revenus mais affichée comme détenue, § 32 / § 45 aucune fuite entre
 * propriétaires. Les faits financiers sont insérés en SQL (mêmes contraintes
 * CHECK que les services) pour maîtriser chaque montant attendu.
 */

const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
// Préparation longue (baux activés par l'API) : délai au-delà des 5 s par défaut.
jest.setTimeout(60000);

const ref = (prefixe) => `${prefixe}-${crypto.randomBytes(5).toString('hex')}`;

async function echeance(b, {
  debut, fin, due, montant, paye = 0, statut,
}) {
  const [ligne] = await q(`
    INSERT INTO rent_schedules (owner_id, lease_id, apartment_id, tenant_id, period_start, period_end, due_date, label,
                                rent_amount, charges_amount, amount_due, amount_paid, status)
    VALUES (:owner, :lease, :apt, :tenant, :debut, :fin, :due, 'Loyer', :montant, 0, :montant, :paye, :statut)
    RETURNING id`, {
    owner: b.lease.owner_id, lease: b.lease.id, apt: b.apartment.id, tenant: b.tenant.id, debut, fin, due, montant, paye, statut,
  });
  return ligne.id;
}

/** Paiement + allocations ; un paiement remboursé a ses allocations contrepassées. */
async function paiement(p, b, {
  montant, le, statut = 'valide', allocations,
}) {
  const [rp] = await q(`
    INSERT INTO rent_payments (owner_id, tenant_id, lease_id, apartment_id, amount, method, paid_on, reference, status, refunded_at, recorded_by)
    VALUES (:owner, :tenant, :lease, :apt, :montant, 'especes', :le, :reference, :statut,
            CASE WHEN :statut = 'rembourse' THEN now() END, :user)
    RETURNING id`, {
    owner: p.ownerId, tenant: b.tenant.id, lease: b.lease.id, apt: b.apartment.id, montant, le, reference: ref('PAY'), statut, user: p.user.id,
  });
  for (const a of allocations) {
    await q(`
      INSERT INTO payment_allocations (owner_id, rent_payment_id, rent_schedule_id, charge_id, amount, reversed_at)
      VALUES (:owner, :rp, :echeance, :charge, :montant, CASE WHEN :statut = 'rembourse' THEN now() END)`, {
      owner: p.ownerId, rp: rp.id, echeance: a.echeance || null, charge: a.charge || null, montant: a.montant, statut,
    });
  }
  return rp.id;
}

async function categorie(code) {
  const [c] = await q('SELECT id FROM expense_categories WHERE owner_id IS NULL AND code = :code', { code });
  return c.id;
}

async function depense(p, {
  building, apartment = null, montant, le, statut = 'valide', code = 'plomberie',
}) {
  await q(`
    INSERT INTO expenses (owner_id, building_id, apartment_id, category_id, amount, method, spent_on, description, status, created_by)
    VALUES (:owner, :building, :apartment, :cat, :montant, 'especes', :le, :description, :statut, :user)`, {
    owner: p.ownerId, building, apartment, cat: await categorie(code), montant, le, description: `Dépense ${montant}`, statut, user: p.user.id,
  });
}

async function mouvement(p, {
  building = null, montant, le, categorie: cat, annule = false,
}) {
  await q(`
    INSERT INTO cash_movements (owner_id, building_id, direction, category, amount, method, occurred_on, label, source_type, is_deposit, cancelled_at)
    VALUES (:owner, :building, 'entree', :cat, :montant, 'especes', :le, 'Mouvement', 'manuel', :depot, CASE WHEN :annule THEN now() END)`, {
    owner: p.ownerId, building, cat, montant, le, depot: cat === 'caution', annule,
  });
}

let numeroTravaux = 0;
async function travaux(p, { building, statut, termine = false }) {
  numeroTravaux += 1;
  await q(`
    INSERT INTO work_orders (owner_id, number, building_id, title, category, status, completed_at)
    VALUES (:owner, :numero, :building, 'Réparation', 'plomberie', :statut, CASE WHEN :termine THEN now() END)`, {
    owner: p.ownerId, numero: numeroTravaux, building, statut, termine,
  });
}

async function incident(p, { building, statut }) {
  await q(`
    INSERT INTO incidents (owner_id, building_id, reference, category, title, description, status, reported_by)
    VALUES (:owner, :building, :reference, 'fuite', 'Fuite', 'Fuite sous l’évier', :statut, :user)`, {
    owner: p.ownerId, building, reference: ref('INC'), statut, user: p.user.id,
  });
}

/** Les échéances générées à l'activation sont remplacées par des échéances maîtrisées. */
async function viderEcheances(b) {
  await q('DELETE FROM rent_schedules WHERE lease_id = :id', { id: b.lease.id });
}

describe('Tableau de bord (§ 6, § 48)', () => {
  const jour = aujourdhui();
  const M = jour.slice(0, 7);
  const P = ajouterMois(`${M}-01`, -1).slice(0, 7);
  let A;
  let B;
  let a1; // bail 300 000 — immeuble 1
  let a2; // bail 200 000 — immeuble 2
  let b1; // bail du propriétaire B

  beforeAll(async () => {
    cache._memoire.vider();
    A = await nouveauProprietaire();
    B = await nouveauProprietaire({ first_name: 'Intrus', last_name: 'Secret' });
    a1 = await bailActif(A, { appartement: { rent_amount: 300000 } });
    a2 = await bailActif(A, { appartement: { rent_amount: 200000 } });
    b1 = await bailActif(B, { appartement: { rent_amount: 900000 } });
    await Promise.all([viderEcheances(a1), viderEcheances(a2), viderEcheances(b1)]);

    // Loyers : S1 payé (mois précédent), S3 en retard (mois précédent),
    // S2 du mois partiellement payé et en retard, S4 du mois payé.
    const s1 = await echeance(a1, { debut: `${P}-01`, fin: `${P}-15`, due: `${P}-05`, montant: 300000, paye: 300000, statut: 'paye' });
    await echeance(a1, { debut: `${P}-16`, fin: `${P}-28`, due: `${P}-20`, montant: 300000, statut: 'en_retard' });
    const s2 = await echeance(a1, { debut: `${M}-01`, fin: `${M}-28`, due: `${M}-01`, montant: 300000, paye: 100000, statut: 'en_retard' });
    const s4 = await echeance(a2, { debut: `${M}-01`, fin: `${M}-28`, due: `${M}-01`, montant: 200000, paye: 200000, statut: 'paye' });

    // Charge refacturée (facture répartie) payée en partie.
    const [ci] = await q(`
      INSERT INTO charge_invoices (owner_id, building_id, charge_type, period_start, period_end, amount, allocation_method, status)
      VALUES (:owner, :b, 'eau', :debut, :debut, 90000, 'egale', 'repartie') RETURNING id`, { owner: A.ownerId, b: a1.building.id, debut: `${M}-01` });
    const [ca] = await q(`
      INSERT INTO charge_allocations (owner_id, charge_invoice_id, apartment_id, share, amount, explanation)
      VALUES (:owner, :ci, :apt, 1, 60000, 'Part unique') RETURNING id`, { owner: A.ownerId, ci: ci.id, apt: a1.apartment.id });
    const [charge] = await q(`
      INSERT INTO charges (owner_id, lease_id, tenant_id, apartment_id, charge_invoice_id, charge_allocation_id, charge_type, label, amount, amount_paid, due_date, status)
      VALUES (:owner, :lease, :tenant, :apt, :ci, :ca, 'eau', 'Eau', 60000, 25000, :due, 'partiellement_paye') RETURNING id`, {
      owner: A.ownerId, lease: a1.lease.id, tenant: a1.tenant.id, apt: a1.apartment.id, ci: ci.id, ca: ca.id, due: `${M}-01`,
    });
    // Facture commune encore à répartir (§ 48 « quelle facture dois-je répartir ? »).
    await q(`
      INSERT INTO charge_invoices (owner_id, building_id, charge_type, period_start, period_end, amount, allocation_method, status)
      VALUES (:owner, :b, 'electricite', :debut, :debut, 45000, 'egale', 'brouillon')`, { owner: A.ownerId, b: a1.building.id, debut: `${M}-01` });

    await paiement(A, a1, { montant: 100000, le: jour, allocations: [{ echeance: s2, montant: 100000 }] });
    await paiement(A, a1, { montant: 300000, le: `${P}-10`, allocations: [{ echeance: s1, montant: 300000 }] });
    await paiement(A, a2, { montant: 200000, le: `${M}-01`, allocations: [{ echeance: s4, montant: 200000 }] });
    await paiement(A, a1, { montant: 25000, le: `${M}-01`, allocations: [{ charge: charge.id, montant: 25000 }] });
    // Paiement remboursé : jamais un revenu.
    await paiement(A, a1, {
      montant: 50000, le: jour, statut: 'rembourse', allocations: [{ echeance: s2, montant: 50000 }],
    });

    // Autres revenus 40 000 ; la caution versée (700 000) n'est PAS un revenu (§ 55.4).
    await mouvement(A, { building: a1.building.id, montant: 40000, le: `${M}-01`, categorie: 'autre_revenu' });
    await mouvement(A, { building: a1.building.id, montant: 12345, le: `${M}-01`, categorie: 'autre_revenu', annule: true });
    await mouvement(A, { building: a1.building.id, montant: 700000, le: `${M}-01`, categorie: 'caution' });
    await q("UPDATE deposits SET amount_received = 700000, status = 'detenue' WHERE lease_id = :id", { id: a1.lease.id });
    await q("UPDATE deposits SET amount_received = 700000, amount_refunded = 200000, status = 'restitution_en_cours' WHERE lease_id = :id", { id: a2.lease.id });

    // Dépenses : 150 000 + 80 000 dans le mois, 50 000 le mois précédent, une annulée.
    await depense(A, { building: a1.building.id, apartment: a1.apartment.id, montant: 150000, le: `${M}-01` });
    await depense(A, { building: a2.building.id, apartment: a2.apartment.id, montant: 80000, le: jour });
    await depense(A, { building: a1.building.id, apartment: a1.apartment.id, montant: 50000, le: `${P}-01` });
    await depense(A, { building: a1.building.id, apartment: a1.apartment.id, montant: 999999, le: jour, statut: 'annulee' });

    await travaux(A, { building: a1.building.id, statut: 'en_cours' });
    await travaux(A, { building: a2.building.id, statut: 'termine', termine: true });
    await travaux(A, { building: a1.building.id, statut: 'signale' });
    await incident(A, { building: a1.building.id, statut: 'signale' });
    await incident(A, { building: a1.building.id, statut: 'resolu' });

    await q(`
      INSERT INTO payment_transactions (owner_id, tenant_id, lease_id, provider, mode, reference, amount, status, initiated_by)
      VALUES (:owner, :tenant, :lease, 'wave', 'preuve', :reference, 300000, 'en_attente', :user)`, {
      owner: A.ownerId, tenant: a1.tenant.id, lease: a1.lease.id, reference: ref('TX'), user: A.user.id,
    });
    await q(`
      INSERT INTO reconciliation_entries (owner_id, type, status, amount, payer_phone)
      VALUES (:owner, 'non_identifie', 'en_attente', 15000, '+221770000000')`, { owner: A.ownerId });

    // Propriétaire B : gros montants qui ne doivent JAMAIS apparaître chez A.
    const sb = await echeance(b1, { debut: `${M}-01`, fin: `${M}-28`, due: `${M}-01`, montant: 900000, paye: 900000, statut: 'paye' });
    await paiement(B, b1, { montant: 900000, le: jour, allocations: [{ echeance: sb, montant: 900000 }] });
    await depense(B, { building: b1.building.id, apartment: b1.apartment.id, montant: 777000, le: jour });
    await mouvement(B, { building: b1.building.id, montant: 555000, le: jour, categorie: 'autre_revenu' });
    await travaux(B, { building: b1.building.id, statut: 'en_cours' });
    await incident(B, { building: b1.building.id, statut: 'signale' });
  });

  afterAll(fermer);

  test('chiffres du mois : patrimoine, loyers, revenus hors caution, dépenses, cautions détenues, à traiter', async () => {
    const res = await api().get('/api/v1/dashboard').set(A.h);
    expect(res.status).toBe(200);
    const d = res.body.data.dashboard;
    expect(d.mois).toBe(M);
    expect(d.patrimoine).toEqual({
      immeubles: 2, appartements: 2, occupes: 2, disponibles: 0, en_travaux: 0, indisponibles: 0, taux_occupation: 100, taux_vacance: 0,
    });
    // À recevoir du mois : S2 300 000 + S4 200 000 ; encaissé 100 000 + 200 000 ;
    // impayés : reste de S2 (200 000) + S3 (300 000).
    expect(d.loyers).toEqual({ a_recevoir: 500000, encaisses: 300000, impayes: 500000 });
    // Revenus : loyers 300 000, charges 25 000, autres 40 000 — ni caution, ni remboursé, ni annulé.
    expect(d.revenus).toEqual({
      loyers: 300000, charges: 25000, autres: 40000, total: 365000,
    });
    expect(d.depenses).toBe(230000);
    expect(d.resultat).toBe(135000);
    expect(d.travaux_en_cours).toBe(1);
    expect(d.cautions_detenues).toBe(700000 + 500000);
    expect(d.a_traiter).toEqual({
      preuves_a_valider: 1, a_rapprocher: 1, factures_a_repartir: 1, incidents_ouverts: 1,
    });
  });

  test('§ 48 : qui n’a pas payé, appartement le plus coûteux, événements du jour', async () => {
    const d = (await api().get('/api/v1/dashboard').set(A.h)).body.data.dashboard;

    expect(d.qui_n_a_pas_paye.total_debiteurs).toBe(1);
    expect(d.qui_n_a_pas_paye.locataires).toHaveLength(1);
    expect(d.qui_n_a_pas_paye.locataires[0]).toMatchObject({
      tenant_id: a1.tenant.id, apartment_id: a1.apartment.id, montant: 500000, echeances: 2, plus_ancienne_echeance: `${P}-20`,
    });

    expect(d.appartement_le_plus_couteux.map((x) => [x.apartment_id, x.depenses])).toEqual([
      [a1.apartment.id, 200000],
      [a2.apartment.id, 80000],
    ]);

    const types = d.aujourd_hui.map((e) => e.type);
    expect(d.aujourd_hui.filter((e) => e.type === 'paiement_recu').map((e) => e.montant)).toEqual([100000]);
    expect(types.filter((t) => t === 'travaux_crees')).toHaveLength(3);
    expect(types.filter((t) => t === 'travaux_termines')).toHaveLength(1);
    expect(types.filter((t) => t === 'incident_signale')).toHaveLength(2);
    expect(d.aujourd_hui.filter((e) => e.type === 'depense').map((e) => e.montant)).toContain(-80000);
    expect(d.aujourd_hui.length).toBeLessThanOrEqual(20);
  });

  test('isolation : aucune donnée du propriétaire B dans le tableau de bord de A (§ 45)', async () => {
    const res = await api().get('/api/v1/dashboard').set(A.h);
    const texte = JSON.stringify(res.body);
    for (const trace of [b1.tenant.id, b1.apartment.id, b1.building.id, '900000', '777000', '555000', 'Intrus']) {
      expect(texte).not.toContain(trace);
    }
    const d = (await api().get('/api/v1/dashboard').set(B.h)).body.data.dashboard;
    expect(d.patrimoine.appartements).toBe(1);
    expect(d.revenus).toEqual({
      loyers: 900000, charges: 0, autres: 555000, total: 1455000,
    });
    expect(d.depenses).toBe(777000);
    expect(d.a_traiter).toEqual({
      preuves_a_valider: 0, a_rapprocher: 0, factures_a_repartir: 0, incidents_ouverts: 1,
    });
  });

  test('filtre immeuble : seuls les chiffres de l’immeuble ; immeuble d’autrui 403, inconnu 422', async () => {
    const res = await api().get('/api/v1/dashboard').query({ building_id: a2.building.id }).set(A.h);
    expect(res.status).toBe(200);
    const d = res.body.data.dashboard;
    expect(d.patrimoine.immeubles).toBe(1);
    expect(d.patrimoine.appartements).toBe(1);
    expect(d.loyers).toEqual({ a_recevoir: 200000, encaisses: 200000, impayes: 0 });
    expect(d.revenus).toEqual({
      loyers: 200000, charges: 0, autres: 0, total: 200000,
    });
    expect(d.depenses).toBe(80000);
    expect(d.cautions_detenues).toBe(500000);
    expect(d.travaux_en_cours).toBe(0);
    // Le paiement non identifié n'a pas d'immeuble : il reste à traiter partout.
    expect(d.a_traiter).toEqual({
      preuves_a_valider: 0, a_rapprocher: 1, factures_a_repartir: 0, incidents_ouverts: 0,
    });
    expect(d.qui_n_a_pas_paye.locataires).toEqual([]);

    const autre = await api().get('/api/v1/dashboard').query({ building_id: b1.building.id }).set(A.h);
    expect(autre.status).toBe(403);
    const inconnu = await api().get('/api/v1/dashboard').query({ building_id: crypto.randomUUID() }).set(A.h);
    expect(inconnu.status).toBe(422);
  });

  test('mois passé en paramètre : loyers et dépenses de ce mois', async () => {
    const d = (await api().get('/api/v1/dashboard').query({ mois: P }).set(A.h)).body.data.dashboard;
    expect(d.mois).toBe(P);
    expect(d.loyers.a_recevoir).toBe(600000);
    expect(d.loyers.encaisses).toBe(300000);
    expect(d.revenus.loyers).toBe(300000);
    expect(d.depenses).toBe(50000);
  });

  test('validation : mois et immeuble invalides → 422 ; sans jeton → 401', async () => {
    expect((await api().get('/api/v1/dashboard').query({ mois: '2026-13' }).set(A.h)).status).toBe(422);
    expect((await api().get('/api/v1/dashboard').query({ building_id: 'pas-un-uuid' }).set(A.h)).status).toBe(422);
    expect((await api().get('/api/v1/dashboard/graphiques').query({ nb_mois: 25 }).set(A.h)).status).toBe(422);
    expect((await api().get('/api/v1/dashboard')).status).toBe(401);
  });

  test('graphiques : chaque mois présent, séries exactes, caution exclue', async () => {
    const res = await api().get('/api/v1/dashboard/graphiques').query({ mois_fin: M, nb_mois: 3 }).set(A.h);
    expect(res.status).toBe(200);
    const g = res.body.data.graphiques;
    const M2 = ajouterMois(`${M}-01`, -2).slice(0, 7);
    expect(g.periode).toMatchObject({ mois_debut: M2, mois_fin: M, nb_mois: 3 });
    expect(g.revenus_mensuels).toEqual([
      {
        mois: M2, loyers: 0, charges: 0, autres: 0, total: 0,
      },
      {
        mois: P, loyers: 300000, charges: 0, autres: 0, total: 300000,
      },
      {
        mois: M, loyers: 300000, charges: 25000, autres: 40000, total: 365000,
      },
    ]);
    expect(g.depenses_mensuelles).toEqual([{ mois: M2, total: 0 }, { mois: P, total: 50000 }, { mois: M, total: 230000 }]);
    expect(g.loyers_mensuels).toEqual([
      {
        mois: M2, a_recevoir: 0, encaisses: 0, impayes: 0,
      },
      {
        mois: P, a_recevoir: 600000, encaisses: 300000, impayes: 300000,
      },
      {
        mois: M, a_recevoir: 500000, encaisses: 300000, impayes: 200000,
      },
    ]);
    expect(g.evolution_patrimoine).toEqual([
      { mois: M2, immeubles: 0, appartements: 0 },
      { mois: P, immeubles: 0, appartements: 0 },
      { mois: M, immeubles: 2, appartements: 2 },
    ]);
    expect(g.travaux_par_periode).toEqual([
      { mois: M2, crees: 0, termines: 0 },
      { mois: P, crees: 0, termines: 0 },
      { mois: M, crees: 3, termines: 1 },
    ]);
    expect(g.depenses_par_categorie).toEqual([
      expect.objectContaining({
        code: 'plomberie', cash_group: 'travaux', total: 280000, nombre: 3,
      }),
    ]);
  });

  test('graphiques : 12 mois par défaut, filtre immeuble appliqué', async () => {
    const g = (await api().get('/api/v1/dashboard/graphiques').query({ building_id: a2.building.id }).set(A.h)).body.data.graphiques;
    expect(g.revenus_mensuels).toHaveLength(12);
    expect(g.revenus_mensuels[11]).toEqual({
      mois: M, loyers: 200000, charges: 0, autres: 0, total: 200000,
    });
    expect(g.evolution_patrimoine[11]).toEqual({ mois: M, immeubles: 1, appartements: 1 });
    expect(g.depenses_par_categorie.map((c) => c.total)).toEqual([80000]);
  });
});
