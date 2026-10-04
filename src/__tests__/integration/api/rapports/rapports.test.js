'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, bailActif, creerAppartement, creerImmeuble, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 26 rapports (financier, immobilier, travaux, locataires), § 4 obj. 21 et
 * § 48 rentabilité par appartement, § 55.4 caution exclue, § 32 / § 45
 * isolation entre propriétaires, export CSV (BOM, `;`, injection de formules).
 *
 * Période étudiée : 1er janvier → 31 mars 2025 (90 jours), dans le passé pour
 * que les chiffres ne dépendent pas de la date d'exécution. Les faits
 * financiers sont insérés en SQL pour maîtriser chaque montant.
 */

// Préparation longue (baux activés par l'API) : délai au-delà des 5 s par défaut.
jest.setTimeout(60000);

const DU = '2025-01-01';
const AU = '2025-03-31';
const PERIODE = { du: DU, au: AU };

const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const ref = (prefixe) => `${prefixe}-${crypto.randomBytes(5).toString('hex')}`;

async function echeance(b, {
  debut, due, montant, paye = 0, statut,
}) {
  const [ligne] = await q(`
    INSERT INTO rent_schedules (owner_id, lease_id, apartment_id, tenant_id, period_start, period_end, due_date, label,
                                rent_amount, charges_amount, amount_due, amount_paid, status)
    VALUES (:owner, :lease, :apt, :tenant, :debut, CAST(:debut AS date) + 27, :due, 'Loyer', :montant, 0, :montant, :paye, :statut)
    RETURNING id`, {
    owner: b.lease.owner_id, lease: b.lease.id, apt: b.apartment.id, tenant: b.tenant.id, debut, due, montant, paye, statut,
  });
  return ligne.id;
}

async function paiement(p, b, {
  montant, le, statut = 'valide', echeance: rs = null, charge = null,
}) {
  const [rp] = await q(`
    INSERT INTO rent_payments (owner_id, tenant_id, lease_id, apartment_id, amount, method, paid_on, reference, status, refunded_at, recorded_by)
    VALUES (:owner, :tenant, :lease, :apt, :montant, 'especes', :le, :reference, :statut,
            CASE WHEN :statut = 'rembourse' THEN now() END, :user)
    RETURNING id`, {
    owner: p.ownerId, tenant: b.tenant.id, lease: b.lease.id, apt: b.apartment.id, montant, le, reference: ref('PAY'), statut, user: p.user.id,
  });
  await q(`
    INSERT INTO payment_allocations (owner_id, rent_payment_id, rent_schedule_id, charge_id, amount, reversed_at)
    VALUES (:owner, :rp, :rs, :charge, :montant, CASE WHEN :statut = 'rembourse' THEN now() END)`, {
    owner: p.ownerId, rp: rp.id, rs, charge, montant, statut,
  });
}

async function depense(p, {
  building, apartment = null, montant, le, statut = 'valide', code = 'plomberie', workOrder = null, contractor = null,
}) {
  await q(`
    INSERT INTO expenses (owner_id, building_id, apartment_id, category_id, amount, method, spent_on, status,
                          work_order_id, contractor_id, created_by)
    VALUES (:owner, :building, :apartment,
            (SELECT id FROM expense_categories WHERE owner_id IS NULL AND code = :code),
            :montant, 'especes', :le, :statut, :workOrder, :contractor, :user)`, {
    owner: p.ownerId, building, apartment, code, montant, le, statut, workOrder, contractor, user: p.user.id,
  });
}

async function mouvement(p, {
  building = null, apartment = null, montant, le, categorie, annule = false,
}) {
  await q(`
    INSERT INTO cash_movements (owner_id, building_id, apartment_id, direction, category, amount, method, occurred_on, label,
                                source_type, is_deposit, cancelled_at)
    VALUES (:owner, :building, :apartment, 'entree', :categorie, :montant, 'especes', :le, 'Mouvement', 'manuel', :depot,
            CASE WHEN :annule THEN now() END)`, {
    owner: p.ownerId, building, apartment, categorie, montant, le, depot: categorie === 'caution', annule,
  });
}

async function artisan(p, nom) {
  const [c] = await q(`INSERT INTO contractors (owner_id, name, trade) VALUES (:owner, :nom, 'plombier') RETURNING id`, { owner: p.ownerId, nom });
  return c.id;
}

let numeroTravaux = 0;
async function travaux(p, {
  building, apartment = null, categorie = 'plomberie', statut, cree, termine = null, estime = null, reel = null, contractor = null,
}) {
  numeroTravaux += 1;
  const [w] = await q(`
    INSERT INTO work_orders (owner_id, number, building_id, apartment_id, contractor_id, title, category, status,
                             estimated_amount, actual_amount, completed_at, created_at)
    VALUES (:owner, :numero, :building, :apartment, :contractor, 'Intervention', :categorie, :statut, :estime, :reel, :termine, :cree)
    RETURNING id`, {
    owner: p.ownerId, numero: numeroTravaux, building, apartment, contractor, categorie, statut, estime, reel, termine, cree,
  });
  return w.id;
}

/** Découpe un CSV `;` (guillemets RFC 4180) en lignes de cellules. */
function lireCsv(texte) {
  const lignes = [];
  let ligne = [];
  let cellule = '';
  let entreGuillemets = false;
  for (let i = 0; i < texte.length; i += 1) {
    const c = texte[i];
    if (entreGuillemets) {
      if (c === '"' && texte[i + 1] === '"') { cellule += '"'; i += 1; } else if (c === '"') entreGuillemets = false;
      else cellule += c;
    } else if (c === '"') entreGuillemets = true;
    else if (c === ';') { ligne.push(cellule); cellule = ''; } else if (c === '\r' && texte[i + 1] === '\n') {
      ligne.push(cellule); lignes.push(ligne); ligne = []; cellule = ''; i += 1;
    } else cellule += c;
  }
  if (cellule || ligne.length) { ligne.push(cellule); lignes.push(ligne); }
  return lignes;
}

const valeur = (lignes, libelle) => lignes.find((l) => l[0] === libelle)?.[1];

describe('Rapports (§ 26) et rentabilité (§ 4.21, § 48)', () => {
  let A;
  let B;
  let a1; // immeuble 1, bail actif depuis le 01/01/2025, loyer 300 000
  let a2; // immeuble 2, bail du 01/02 au 15/03/2025, loyer 200 000
  let a3; // immeuble 1, appartement vacant, loyer 150 000
  let b1;
  let c1;
  let c2;

  // Jeu de données en LECTURE SEULE : aucun test ne modifie A ni B (le test
  // d'injection CSV crée son propre propriétaire), l'ordre est donc indifférent.
  beforeAll(async () => {
    A = await nouveauProprietaire();
    B = await nouveauProprietaire();
    a1 = await bailActif(A, { appartement: { rent_amount: 300000 }, bail: { start_date: '2025-01-01' } });
    a2 = await bailActif(A, { appartement: { rent_amount: 200000 }, bail: { start_date: '2025-02-01' } });
    a3 = await creerAppartement(A, a1.building.id, { rent_amount: 150000 });
    b1 = await bailActif(B, { appartement: { rent_amount: 800000 }, bail: { start_date: '2025-01-01' } });
    await q('DELETE FROM rent_schedules WHERE lease_id IN (:ids)', { ids: [a1.lease.id, a2.lease.id, b1.lease.id] });

    // Chronologie maîtrisée : activation datée, fin du bail 2 au 15/03/2025.
    await q("UPDATE leases SET activated_at = '2025-01-01T09:00:00Z' WHERE id = :id", { id: a1.lease.id });
    await q("UPDATE leases SET activated_at = '2025-02-01T09:00:00Z', status = 'termine', ended_on = '2025-03-15', termination_reason = 'Mutation' WHERE id = :id", { id: a2.lease.id });
    await q("UPDATE apartments SET status = 'disponible' WHERE id = :id", { id: a2.apartment.id });

    // Bail 1 : janvier payé en janvier ; février payé le 10/04 (APRÈS la période) ; mars impayé.
    const jan = await echeance(a1, { debut: '2025-01-01', due: '2025-01-05', montant: 300000, paye: 300000, statut: 'paye' });
    const fev = await echeance(a1, { debut: '2025-02-01', due: '2025-02-05', montant: 300000, paye: 300000, statut: 'paye' });
    const mar = await echeance(a1, { debut: '2025-03-01', due: '2025-03-05', montant: 300000, statut: 'en_retard' });
    await paiement(A, a1, { montant: 300000, le: '2025-01-05', echeance: jan });
    await paiement(A, a1, { montant: 300000, le: '2025-04-10', echeance: fev });
    await paiement(A, a1, { montant: 70000, le: '2025-02-10', statut: 'rembourse', echeance: mar });
    // Bail 2 : février payé ; mars payé 50 000 sur 200 000.
    const fev2 = await echeance(a2, { debut: '2025-02-01', due: '2025-02-05', montant: 200000, paye: 200000, statut: 'paye' });
    const mar2 = await echeance(a2, { debut: '2025-03-01', due: '2025-03-05', montant: 200000, paye: 50000, statut: 'en_retard' });
    await paiement(A, a2, { montant: 200000, le: '2025-02-05', echeance: fev2 });
    await paiement(A, a2, { montant: 50000, le: '2025-03-06', echeance: mar2 });

    // Facture commune de février : 100 000, 60 000 refacturés, 20 000 récupérés.
    const [ci] = await q(`
      INSERT INTO charge_invoices (owner_id, building_id, charge_type, period_start, period_end, amount, allocation_method, status)
      VALUES (:owner, :b, 'eau', '2025-02-01', '2025-02-28', 100000, 'coefficient', 'repartie') RETURNING id`, { owner: A.ownerId, b: a1.building.id });
    const [ca] = await q(`
      INSERT INTO charge_allocations (owner_id, charge_invoice_id, apartment_id, share, amount, explanation)
      VALUES (:owner, :ci, :apt, 0.6, 60000, 'Coefficient 0,6') RETURNING id`, { owner: A.ownerId, ci: ci.id, apt: a1.apartment.id });
    const [charge] = await q(`
      INSERT INTO charges (owner_id, lease_id, tenant_id, apartment_id, charge_invoice_id, charge_allocation_id, charge_type, label, amount, amount_paid, due_date, status)
      VALUES (:owner, :lease, :tenant, :apt, :ci, :ca, 'eau', 'Eau février', 60000, 20000, '2025-03-01', 'partiellement_paye') RETURNING id`, {
      owner: A.ownerId, lease: a1.lease.id, tenant: a1.tenant.id, apt: a1.apartment.id, ci: ci.id, ca: ca.id,
    });
    await paiement(A, a1, { montant: 20000, le: '2025-03-01', charge: charge.id });

    // Autres revenus 30 000 (rattachés à l'appartement 1) ; caution et annulé exclus.
    await mouvement(A, {
      building: a1.building.id, apartment: a1.apartment.id, montant: 30000, le: '2025-03-01', categorie: 'autre_revenu',
    });
    await mouvement(A, { building: a1.building.id, montant: 99999, le: '2025-03-02', categorie: 'autre_revenu', annule: true });
    await mouvement(A, { building: a1.building.id, montant: 700000, le: '2025-01-01', categorie: 'caution' });

    // Travaux : W1 terminé (créé en février), W2 en cours, W3 annulé, W4 créé
    // AVANT la période mais terminé pendant.
    c1 = await artisan(A, 'Plomberie Ndiaye');
    c2 = await artisan(A, 'Atelier Fall');
    const w1 = await travaux(A, {
      building: a1.building.id, apartment: a1.apartment.id, statut: 'termine', cree: '2025-02-10T10:00:00Z',
      termine: '2025-02-20T10:00:00Z', estime: 120000, reel: 100000, contractor: c1,
    });
    await travaux(A, {
      building: a1.building.id, statut: 'en_cours', cree: '2025-03-10T10:00:00Z', estime: 50000, contractor: c1,
    });
    await travaux(A, {
      building: a2.building.id, categorie: 'peinture', statut: 'annule', cree: '2025-01-20T10:00:00Z', estime: 30000, contractor: c2,
    });
    await travaux(A, {
      building: a1.building.id, statut: 'termine', cree: '2024-12-01T10:00:00Z', termine: '2025-01-15T10:00:00Z', reel: 10000,
    });

    // Dépenses : 100 000 (travaux W1, appartement 1), 40 000 (appartement 2),
    // une annulée et une hors période.
    await depense(A, {
      building: a1.building.id, apartment: a1.apartment.id, montant: 100000, le: '2025-02-20', workOrder: w1, contractor: c1,
    });
    await depense(A, {
      building: a2.building.id, apartment: a2.apartment.id, montant: 40000, le: '2025-03-01', code: 'nettoyage',
    });
    await depense(A, {
      building: a1.building.id, montant: 55555, le: '2025-03-01', statut: 'annulee',
    });
    await depense(A, { building: a1.building.id, montant: 5000, le: '2025-05-01' });

    // Propriétaire B, même période : ne doit jamais apparaître chez A.
    const rb = await echeance(b1, {
      debut: '2025-01-01', due: '2025-01-05', montant: 800000, paye: 800000, statut: 'paye',
    });
    await paiement(B, b1, { montant: 800000, le: '2025-01-05', echeance: rb });
    await depense(B, { building: b1.building.id, apartment: b1.apartment.id, montant: 333000, le: '2025-02-01' });
  });

  afterAll(fermer);

  test('financier : revenus hors caution, dépenses, impayés à la date de fin, bénéfice net, charges', async () => {
    const res = await api().get('/api/v1/rapports/financier').query(PERIODE).set(A.h);
    expect(res.status).toBe(200);
    const r = res.body.data.rapport;
    expect(r.periode).toEqual({ du: DU, au: AU, jours: 90 });
    expect(r.building).toBeNull();
    expect(r.revenus).toEqual({
      loyers: 550000, charges_recuperees: 20000, autres_revenus: 30000, total: 600000,
    });
    expect(r.depenses.total).toBe(140000);
    expect(r.depenses.par_categorie.map((c) => [c.code, c.total, c.nombre])).toEqual([
      ['plomberie', 100000, 1],
      ['nettoyage', 40000, 1],
    ]);
    expect(r.benefice_net).toBe(460000);
    // Février du bail 1 était impayé au 31/03 (réglé le 10/04) : 300 000 + 300 000 + 150 000.
    expect(r.impayes).toEqual({
      date: AU, montant: 750000, echeances: 3, locataires: 2,
    });
    expect(r.charges).toEqual({
      nombre_factures: 1,
      factures_total: 100000,
      refacturees_locataires: 60000,
      recuperees_locataires: 20000,
      reste_a_recouvrer: 40000,
      a_charge_proprietaire: 40000,
    });
    const parImmeuble = Object.fromEntries(r.par_immeuble.map((b) => [b.building_id, b]));
    expect(parImmeuble[a1.building.id]).toMatchObject({
      revenus: {
        loyers: 300000, charges_recuperees: 20000, autres_revenus: 30000, total: 350000,
      },
      depenses: 100000,
      benefice_net: 250000,
      impayes: 600000,
    });
    expect(parImmeuble[a2.building.id]).toMatchObject({
      revenus: {
        loyers: 250000, charges_recuperees: 0, autres_revenus: 0, total: 250000,
      },
      depenses: 40000,
      benefice_net: 210000,
      impayes: 150000,
    });
    expect(Object.keys(parImmeuble)).toHaveLength(2);
    const texte = JSON.stringify(res.body);
    expect(texte).not.toContain(b1.building.id);
    expect(texte).not.toContain('800000');
    expect(texte).not.toContain('333000');
  });

  test('financier filtré par immeuble ; immeuble d’un autre propriétaire → 403', async () => {
    const r = (await api().get('/api/v1/rapports/financier').query({ ...PERIODE, building_id: a2.building.id }).set(A.h)).body.data.rapport;
    expect(r.building).toEqual({ id: a2.building.id, name: a2.building.name });
    expect(r.revenus.total).toBe(250000);
    expect(r.depenses.total).toBe(40000);
    expect(r.impayes.montant).toBe(150000);
    expect(r.charges.factures_total).toBe(0);
    expect(r.par_immeuble).toHaveLength(1);

    const autre = await api().get('/api/v1/rapports/financier').query({ ...PERIODE, building_id: b1.building.id }).set(A.h);
    expect(autre.status).toBe(403);
    expect(autre.body.error.code).toBe('ACCES_AUTRE_PROPRIETAIRE');
  });

  test('isolation : le rapport de B ne contient que ses données', async () => {
    const r = (await api().get('/api/v1/rapports/financier').query(PERIODE).set(B.h)).body.data.rapport;
    expect(r.revenus.total).toBe(800000);
    expect(r.depenses.total).toBe(333000);
    expect(r.impayes.montant).toBe(0);
    expect(r.par_immeuble.map((b) => b.building_id)).toEqual([b1.building.id]);
  });

  test('immobilier : occupation actuelle, vacance, occupation réelle sur la période, loyers', async () => {
    const res = await api().get('/api/v1/rapports/immobilier').query(PERIODE).set(A.h);
    expect(res.status).toBe(200);
    const r = res.body.data.rapport;
    expect(r).toMatchObject({
      immeubles: 2,
      appartements: 3,
      occupes: 1,
      disponibles: 2,
      taux_occupation: 33.3,
      taux_vacance: 66.7,
      // 90 jours (bail 1) + 43 jours (bail 2 : 28 en février, 15 en mars) sur 3 × 90.
      jours_occupes: 133,
      taux_occupation_periode: 49.3,
      loyers: {
        loyer_mensuel_occupes: 300000, charges_mensuelles_occupes: 0, loyer_moyen: 300000, loyer_potentiel: 650000, manque_a_gagner_vacance: 350000,
      },
    });
    const b1Ligne = r.par_immeuble.find((b) => b.building_id === a1.building.id);
    expect(b1Ligne).toMatchObject({
      appartements: 2, occupes: 1, disponibles: 1, taux_occupation: 50, taux_vacance: 50, jours_occupes: 90,
    });
    const b2Ligne = r.par_immeuble.find((b) => b.building_id === a2.building.id);
    expect(b2Ligne).toMatchObject({
      appartements: 1, occupes: 0, disponibles: 1, jours_occupes: 43, taux_occupation_periode: 47.8,
    });
  });

  test('travaux : créés, terminés, en cours, coûts, catégories, artisans', async () => {
    const res = await api().get('/api/v1/rapports/travaux').query(PERIODE).set(A.h);
    expect(res.status).toBe(200);
    const r = res.body.data.rapport;
    expect(r).toMatchObject({
      crees_sur_periode: 3,
      termines: 1,
      en_cours: 1,
      en_attente: 0,
      annules: 1,
      couts: { estime: 170000, reel: 100000, depenses_liees: 100000 },
      termines_sur_periode: 2,
      en_cours_actuellement: 1,
      depenses_travaux_periode: 100000,
    });
    expect(r.par_categorie.map((c) => [c.category, c.nombre, c.termines, c.cout_estime])).toEqual([
      ['plomberie', 2, 1, 170000],
      ['peinture', 1, 0, 0],
    ]);
    expect(r.artisans.par_montant.map((a) => [a.contractor_id, a.nombre, a.montant_paye])).toEqual([
      [c1, 2, 100000],
      [c2, 1, 0],
    ]);
    expect(r.artisans.par_nombre[0].contractor_id).toBe(c1);
  });

  test('locataires : actifs, arrivées, départs, impayés par locataire', async () => {
    const res = await api().get('/api/v1/rapports/locataires').query(PERIODE).set(A.h);
    expect(res.status).toBe(200);
    const r = res.body.data.rapport;
    expect(r.actifs).toBe(1);
    expect(r.actifs_sur_periode).toBe(2);
    expect(r.arrivees.nombre).toBe(2);
    expect(r.arrivees.baux.map((b) => [b.lease_id, b.date])).toEqual([
      [a1.lease.id, '2025-01-01'],
      [a2.lease.id, '2025-02-01'],
    ]);
    expect(r.departs.nombre).toBe(1);
    expect(r.departs.baux[0]).toMatchObject({ lease_id: a2.lease.id, date: '2025-03-15', motif: 'Mutation' });
    expect(r.impayes.total).toBe(750000);
    expect(r.impayes.locataires.map((l) => [l.tenant_id, l.montant, l.echeances, l.plus_ancienne_echeance])).toEqual([
      [a1.tenant.id, 600000, 2, '2025-02-05'],
      [a2.tenant.id, 150000, 1, '2025-03-05'],
    ]);
  });

  test('rentabilité : chaque appartement classé par résultat net, paginé', async () => {
    const res = await api().get('/api/v1/rapports/rentabilite').query(PERIODE).set(A.h);
    expect(res.status).toBe(200);
    const { items, pagination } = res.body.data;
    expect(pagination.total).toBe(3);
    expect(items.map((l) => [l.apartment_id, l.revenus, l.depenses, l.resultat_net, l.jours_occupation, l.rang])).toEqual([
      [a1.apartment.id, 350000, 100000, 250000, 90, 1],
      [a2.apartment.id, 250000, 40000, 210000, 43, 2],
      [a3.id, 0, 0, 0, 0, 3],
    ]);
    expect(items[0]).toMatchObject({
      loyers: 300000, charges_recuperees: 20000, autres_revenus: 30000, taux_occupation: 100,
    });

    const page2 = (await api().get('/api/v1/rapports/rentabilite').query({ ...PERIODE, limit: 2, page: 2 }).set(A.h)).body.data;
    expect(page2.items.map((l) => l.apartment_id)).toEqual([a3.id]);
    expect(page2.pagination).toMatchObject({ total: 3, totalPages: 2 });

    const parDepenses = (await api().get('/api/v1/rapports/rentabilite').query({ ...PERIODE, tri: 'depenses' }).set(A.h)).body.data;
    expect(parDepenses.items.map((l) => l.apartment_id)).toEqual([a3.id, a2.apartment.id, a1.apartment.id]);
    expect(parDepenses.items.map((l) => l.rang)).toEqual([3, 2, 1]);

    const b = (await api().get('/api/v1/rapports/rentabilite').query({ ...PERIODE, building_id: a2.building.id }).set(A.h)).body.data;
    expect(b.items.map((l) => l.apartment_id)).toEqual([a2.apartment.id]);
  });

  test('validation : dates manquantes, inversées, inexistantes ou période > 3 ans → 422', async () => {
    const cas = [
      { au: AU },
      { du: '2025-04-01', au: '2025-03-31' },
      { du: '2025-02-30', au: '2025-03-31' },
      { du: '2022-01-01', au: '2025-01-01' },
      { ...PERIODE, format: 'pdf' },
      { ...PERIODE, building_id: 'abc' },
    ];
    for (const query of cas) {
      const res = await api().get('/api/v1/rapports/financier').query(query).set(A.h);
      expect(res.status).toBe(422);
    }
    expect((await api().get('/api/v1/rapports/rentabilite').query({ ...PERIODE, tri: 'owner_id' }).set(A.h)).status).toBe(422);
    expect((await api().get('/api/v1/rapports/financier').query({ du: '2022-01-01', au: '2024-12-31' }).set(A.h)).status).toBe(200);
    expect((await api().get('/api/v1/rapports/financier').query(PERIODE)).status).toBe(401);
  });

  test('CSV : BOM UTF-8, séparateur « ; », pièce jointe, chiffres identiques au JSON', async () => {
    const res = await api().get('/api/v1/rapports/financier').query({ ...PERIODE, format: 'csv' }).set(A.h);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="rapport-financier_${DU}_${AU}.csv"`);
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);
    const lignes = lireCsv(res.text.slice(1));
    expect(lignes[0]).toEqual(['Rapport financier']);
    expect(lignes[1]).toEqual(['Du', 'Au', 'Immeuble']);
    expect(lignes[2]).toEqual([DU, AU, 'Tous les immeubles']);
    expect(valeur(lignes, 'Total des revenus (hors caution)')).toBe('600000');
    expect(valeur(lignes, 'Bénéfice net')).toBe('460000');
    expect(valeur(lignes, `Impayés au ${AU}`)).toBe('750000');

    for (const type of ['immobilier', 'travaux', 'locataires', 'rentabilite']) {
      const r = await api().get(`/api/v1/rapports/${type}`).query({ ...PERIODE, format: 'csv' }).set(A.h);
      expect(r.status).toBe(200);
      expect(r.text.charCodeAt(0)).toBe(0xFEFF);
      expect(r.headers['content-disposition']).toContain(`rapport-${type}_`);
    }
    const rent = await api().get('/api/v1/rapports/rentabilite').query({ ...PERIODE, format: 'csv', limit: 1 }).set(A.h);
    const lignesRent = lireCsv(rent.text.slice(1));
    // Export complet malgré `limit` : 3 appartements sous l'en-tête du classement.
    const debut = lignesRent.findIndex((l) => l[0] === 'Rang');
    expect(lignesRent.slice(debut + 1).filter((l) => l.length > 1).map((l) => l[0])).toEqual(['1', '2', '3']);
  });

  test('CSV : injection de formule neutralisée, guillemets et « ; » échappés', async () => {
    // Propriétaire dédié : l'immeuble piégé ne doit pas fausser les comptes
    // exacts du jeu de données de A (tests exécutables dans n'importe quel ordre).
    const proprio = await nouveauProprietaire();
    const piege = await creerImmeuble(proprio, { name: '=HYPERLINK("http://x";"clic")' });
    await creerAppartement(proprio, piege.id, { number: '@SUM', rent_amount: 100000 });
    const res = await api().get('/api/v1/rapports/rentabilite').query({ ...PERIODE, format: 'csv', building_id: piege.id }).set(proprio.h);
    expect(res.status).toBe(200);
    expect(res.text).toContain('"\'=HYPERLINK(""http://x"";""clic"")"');
    const lignes = lireCsv(res.text.slice(1));
    const ligne = lignes.find((l) => l[2] === "'@SUM");
    expect(ligne[1]).toBe('\'=HYPERLINK("http://x";"clic")');
    for (const cellule of lignes.flat()) expect(cellule).not.toMatch(/^[=+@]/);
  });
});
