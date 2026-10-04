'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, creerLocataire, desactiverEdlObligatoire,
  activerLocataire, pngTest, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const { aujourdhui, ajouterJours } = require('../../../../utils/dates.js');

/**
 * Factures communes (§ 16), répartition (§ 17), charges locataires (§ 15,
 * § 28) — couverture complète des routes :
 *   /factures-communes (liste, à répartir, création, détail, modification,
 *   justificatif, aperçu GET/POST, répartition, annulation), /charges (liste,
 *   détail) et /locataire/charges (liste, détail).
 *
 * Pour chaque route : nominal et effets en base, validation, pagination,
 * filtres, règles métier (chaque méthode de répartition, arrondis exacts,
 * explication conservée), atomicité et concurrence.
 */

jest.setTimeout(90000);

const FC = '/api/v1/factures-communes';
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const INJECTIONS = ["'; DROP TABLE charge_invoices; --", "%' OR '1'='1", '_%_', '\\', '"; SELECT pg_sleep(5); --', 'É€漢字'];

async function bailSur(proprio, apartment, tenant, surcharges = {}) {
  const creation = await api().post('/api/v1/baux').set(proprio.h).send({
    apartment_id: apartment.id, tenant_id: tenant.id, start_date: '2026-09-01',
    rent_amount: apartment.rent_amount, deposit_amount: 0, due_day: 5, ...surcharges,
  });
  if (creation.status !== 201) throw new Error(`Bail : ${creation.status} ${JSON.stringify(creation.body)}`);
  const activation = await api().post(`/api/v1/baux/${creation.body.data.lease.id}/activer`).set(proprio.h).send({});
  if (activation.status !== 200) throw new Error(`Activation : ${activation.status} ${JSON.stringify(activation.body)}`);
  return activation.body.data.lease;
}

describe('Factures communes et charges — couverture complète', () => {
  let p;
  let autre;
  let immeuble;
  let apts; // B1 (coef 3, occupé 4 pers.), B2 (coef 2, occupé 1 pers.), B3 (coef 1, vacant)
  let tenants;
  let comptes;
  let immeubleVide;

  const corpsFacture = (surcharges = {}) => ({
    building_id: immeuble.id, charge_type: 'electricite', supplier: 'SENELEC', invoice_number: `F-${crypto.randomBytes(3).toString('hex')}`,
    period_start: '2026-09-01', period_end: '2026-09-30', amount: 100000, due_date: '2026-10-20', allocation_method: 'egale', ...surcharges,
  });
  const creerFacture = async (surcharges = {}, proprio = p) => {
    const res = await api().post(FC).set(proprio.h).send(corpsFacture(surcharges));
    expect(res.status).toBe(201);
    return res.body.data.invoice;
  };

  beforeAll(async () => {
    p = await nouveauProprietaire();
    autre = await nouveauProprietaire();
    await desactiverEdlObligatoire(p);
    immeuble = await creerImmeuble(p, { name: 'Résidence Baobab' });
    immeubleVide = await creerImmeuble(p, { name: 'Immeuble sans appartement' });
    apts = [
      await creerAppartement(p, immeuble.id, { number: 'B1', charge_coefficient: 3 }),
      await creerAppartement(p, immeuble.id, { number: 'B2', charge_coefficient: 2 }),
      await creerAppartement(p, immeuble.id, { number: 'B3', charge_coefficient: 1 }),
    ];
    tenants = [await creerLocataire(p), await creerLocataire(p)];
    await bailSur(p, apts[0], tenants[0], { occupants_count: 4 });
    await bailSur(p, apts[1], tenants[1], { occupants_count: 1 });
    comptes = [await activerLocataire(p, tenants[0]), await activerLocataire(p, tenants[1])];
  }, 120000);
  afterAll(fermer);

  // ── A. Parcours nominal ────────────────────────────────────────────────────
  describe('A — nominal et effets en base', () => {
    test('POST / : 201, forme, ligne en base « brouillon », audit de création ; champs protégés ignorés', async () => {
      const res = await api().post(FC).set(p.h).send({
        ...corpsFacture({ supplier: '  SENELEC  ', notes: '' }), status: 'repartie', owner_id: autre.ownerId, allocated_at: '2020-01-01',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Facture commune enregistrée' });
      const inv = res.body.data.invoice;
      expect(inv).toMatchObject({
        building_id: immeuble.id, charge_type: 'electricite', supplier: 'SENELEC', amount: 100000,
        status: 'brouillon', owner_id: p.ownerId, allocation_method: 'egale', notes: null, allocated_at: null,
      });
      const [ligne] = await q('SELECT * FROM charge_invoices WHERE id = :id', { id: inv.id });
      expect(ligne).toMatchObject({ owner_id: p.ownerId, status: 'brouillon', created_by: p.user.id, amount: 100000 });
      const [audit] = await q("SELECT details FROM audit_logs WHERE action = 'facture_commune.creation' AND entity_id = :id", { id: inv.id });
      expect(audit.details).toMatchObject({ immeuble: 'Résidence Baobab', montant: 100000, methode: 'egale', fournisseur: 'SENELEC' });
    });

    test('GET /:id : détail avec totaux, libellé de méthode, lignes et documents vides', async () => {
      const inv = await creerFacture({ allocation_method: 'coefficient' });
      const res = await api().get(`${FC}/${inv.id}`).set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.invoice).toMatchObject({
        id: inv.id, method_label: 'Selon coefficient', allocations: [], documents: [], allocations_count: 0,
        allocations_total: 0, recharged_total: 0, recharged_paid: 0, building: { id: immeuble.id, name: 'Résidence Baobab' },
      });
    });

    test('GET /a-repartir : brouillons seulement, du plus ancien au plus récent, nombre et total exacts', async () => {
      const proprio = await nouveauProprietaire();
      const bat = await creerImmeuble(proprio);
      const facture = (s) => api().post(FC).set(proprio.h).send({
        building_id: bat.id, charge_type: 'eau', period_start: s.debut, period_end: s.fin, amount: s.montant, allocation_method: 'egale',
      }).then((r) => r.body.data.invoice);
      const vide = await api().get(`${FC}/a-repartir`).set(proprio.h);
      expect(vide.body.data).toEqual({ count: 0, total_amount: 0, invoices: [] });

      const recente = await facture({ debut: '2026-09-01', fin: '2026-09-30', montant: 1000 });
      const ancienne = await facture({ debut: '2026-07-01', fin: '2026-07-31', montant: 2500 });
      const annulee = await facture({ debut: '2026-06-01', fin: '2026-06-30', montant: 99999 });
      await api().post(`${FC}/${annulee.id}/annuler`).set(proprio.h).send({ reason: 'Doublon' });
      const res = await api().get(`${FC}/a-repartir`).set(proprio.h);
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(2);
      expect(res.body.data.total_amount).toBe(3500);
      expect(res.body.data.invoices.map((f) => f.id)).toEqual([ancienne.id, recente.id]);
    });

    test('PATCH /:id : brouillon modifié, audit avec la différence, champs protégés ignorés', async () => {
      const inv = await creerFacture();
      const res = await api().patch(`${FC}/${inv.id}`).set(p.h).send({ amount: 150000, supplier: '', status: 'annulee', allocation_method: 'occupants' });
      expect(res.status).toBe(200);
      expect(res.body.data.invoice).toMatchObject({ amount: 150000, supplier: null, status: 'brouillon', allocation_method: 'occupants' });
      const [audit] = await q("SELECT details FROM audit_logs WHERE action = 'facture_commune.modification' AND entity_id = :id", { id: inv.id });
      expect(JSON.stringify(audit.details)).toMatch(/150000/);
      // Période incohérente APRÈS fusion avec l'existant → 422.
      expect((await api().patch(`${FC}/${inv.id}`).set(p.h).send({ period_end: '2026-08-15' })).status).toBe(422);
      // Changement d'immeuble : vérifié (autre propriétaire → 403).
      const immeubleAutre = await creerImmeuble(autre);
      expect((await api().patch(`${FC}/${inv.id}`).set(p.h).send({ building_id: immeubleAutre.id })).status).toBe(403);
      expect((await api().patch(`${FC}/${inv.id}`).set(p.h).send({ building_id: immeubleVide.id })).status).toBe(200);
    });

    test('POST /:id/document : PDF et image acceptés (type réel), autre contenu refusé ; stocké et listé', async () => {
      const inv = await creerFacture();
      const pdf = await api().post(`${FC}/${inv.id}/document`).set(p.h).attach('fichier', PDF, 'facture.pdf');
      expect(pdf.status).toBe(201);
      expect(pdf.body.data.document).toMatchObject({ category: 'facture', mime_type: 'application/pdf' });
      const png = await api().post(`${FC}/${inv.id}/document`).set(p.h).attach('fichier', await pngTest(), 'scan.png');
      expect(png.status).toBe(201);
      // Un HTML renommé .pdf, un exécutable, un fichier vide : refusés par signature binaire.
      expect((await api().post(`${FC}/${inv.id}/document`).set(p.h).attach('fichier', Buffer.from('<html><script>alert(1)</script></html>'), 'x.pdf')).status).toBe(400);
      expect((await api().post(`${FC}/${inv.id}/document`).set(p.h).attach('fichier', Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00'), 'x.png')).status).toBe(400);
      expect((await api().post(`${FC}/${inv.id}/document`).set(p.h).send({})).status).toBeGreaterThanOrEqual(400);
      expect(await compter('documents', "entity_type = 'charge_invoice' AND entity_id = :id", { id: inv.id })).toBe(2);
      const detail = await api().get(`${FC}/${inv.id}`).set(p.h);
      expect(detail.body.data.invoice.documents).toHaveLength(2);
      // Facture annulée : plus de justificatif (409).
      await api().post(`${FC}/${inv.id}/annuler`).set(p.h).send({ reason: 'Test annulation' });
      const refus = await api().post(`${FC}/${inv.id}/document`).set(p.h).attach('fichier', PDF, 'facture.pdf');
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('FACTURE_ANNULEE');
    });

    test('aperçu GET et POST : même calcul, RIEN n’est écrit', async () => {
      const inv = await creerFacture({ allocation_method: 'coefficient', amount: 60000 });
      const avant = await compter('charge_allocations', 'charge_invoice_id = :id', { id: inv.id });
      const get = await api().get(`${FC}/${inv.id}/apercu`).set(p.h);
      const post = await api().post(`${FC}/${inv.id}/apercu`).set(p.h).send({});
      expect(get.status).toBe(200);
      expect(post.status).toBe(200);
      expect(get.body.data.allocation).toEqual(post.body.data.allocation);
      const calc = get.body.data.allocation;
      expect(calc).toMatchObject({ allocation_method: 'coefficient', total: 60000, basis_total: 6, apartments_count: 3, recharged_total: 50000, owner_share: 10000 });
      expect(calc.lines.map((l) => [l.apartment_number, l.amount, l.recharged])).toEqual([['B1', 30000, true], ['B2', 20000, true], ['B3', 10000, false]]);
      expect(calc.lines[0].tenant).toMatchObject({ id: tenants[0].id });
      expect(calc.lines[2].tenant).toBeNull();
      expect(avant).toBe(0);
      expect(await compter('charge_allocations', 'charge_invoice_id = :id', { id: inv.id })).toBe(0);
      expect(await compter('charges', 'charge_invoice_id = :id', { id: inv.id })).toBe(0);
      expect((await q('SELECT status FROM charge_invoices WHERE id = :id', { id: inv.id }))[0].status).toBe('brouillon');
      // apartment_ids en liste séparée par des virgules (GET).
      const sub = await api().get(`${FC}/${inv.id}/apercu`).query({ apartment_ids: `${apts[0].id},${apts[2].id}` }).set(p.h);
      expect(sub.status).toBe(200);
      expect(sub.body.data.allocation.lines.map((l) => l.amount)).toEqual([45000, 15000]);
    });

    test('POST /:id/repartir : lignes, charges, notification par locataire, audit ; échéance par défaut J+15 sans due_date', async () => {
      const inv = await creerFacture({ due_date: null, amount: 90000 });
      const res = await api().post(`${FC}/${inv.id}/repartir`).set(p.h).send({});
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Facture répartie');
      const d = res.body.data.invoice;
      expect(d).toMatchObject({ status: 'repartie', allocations_count: 3, allocations_total: 90000, recharged_total: 60000 });
      const charges = await q('SELECT * FROM charges WHERE charge_invoice_id = :id ORDER BY amount', { id: inv.id });
      expect(charges).toHaveLength(2);
      const echeance = ajouterJours(aujourdhui(), 15);
      expect(charges.every((c) => c.due_date === echeance && c.amount === 30000 && c.amount_paid === 0 && c.status === 'a_payer')).toBe(true);
      expect(charges.map((c) => c.label)).toEqual(['Électricité septembre 2026 — SENELEC', 'Électricité septembre 2026 — SENELEC']);
      for (const compte of comptes) {
        const notifs = await q("SELECT data FROM notifications WHERE user_id = :u AND type = 'facture' AND data->>'charge_invoice_id' = :id", { u: compte.user.id, id: inv.id });
        expect(notifs).toHaveLength(1);
        expect(notifs[0].data.charge_ids).toHaveLength(1);
      }
      const [audit] = await q("SELECT details FROM audit_logs WHERE action = 'facture_commune.repartition' AND entity_id = :id", { id: inv.id });
      expect(audit.details).toMatchObject({ montant: 90000, appartements: 3, charges_creees: 2, refacture: 60000, a_la_charge_du_proprietaire: 30000 });
    });

    test('POST /:id/annuler : motif conservé dans les notes, charges annulées, locataires prévenus, audit', async () => {
      const inv = await creerFacture({ notes: 'Relevé du 30/09' });
      await api().post(`${FC}/${inv.id}/repartir`).set(p.h).send({});
      const res = await api().post(`${FC}/${inv.id}/annuler`).set(p.h).send({ reason: 'Facture erronée du fournisseur' });
      expect(res.status).toBe(200);
      expect(res.body.data.invoice.status).toBe('annulee');
      expect(res.body.data.invoice.notes).toMatch(/^Relevé du 30\/09\nAnnulée le .+ : Facture erronée du fournisseur$/);
      const charges = await q('SELECT status, cancelled_at FROM charges WHERE charge_invoice_id = :id', { id: inv.id });
      expect(charges.every((c) => c.status === 'annule' && c.cancelled_at)).toBe(true);
      // Lignes de répartition conservées (historique, § 42).
      expect(await compter('charge_allocations', 'charge_invoice_id = :id', { id: inv.id })).toBe(3);
      const notifs = await q("SELECT count(*)::int AS n FROM notifications WHERE user_id = :u AND title LIKE 'Charge annulée%' AND data->>'charge_invoice_id' = :id", { u: comptes[0].user.id, id: inv.id });
      expect(notifs[0].n).toBe(1);
      const [audit] = await q("SELECT details FROM audit_logs WHERE action = 'facture_commune.changement_statut' AND entity_id = :id", { id: inv.id });
      expect(audit.details).toMatchObject({ avant: 'repartie', apres: 'annulee', charges_annulees: 2, motif: 'Facture erronée du fournisseur' });
      expect((await api().patch(`${FC}/${inv.id}`).set(p.h).send({ amount: 5 })).body.error.code).toBe('FACTURE_ANNULEE');
    });
  });

  // ── D. Validation ─────────────────────────────────────────────────────────
  describe('D — validation (422)', () => {
    test.each([
      ['corps vide', {}],
      ['building_id manquant', { building_id: undefined }],
      ['charge_type manquant', { charge_type: undefined }],
      ['période manquante', { period_start: undefined }],
      ['fin de période manquante', { period_end: undefined }],
      ['montant manquant', { amount: undefined }],
      ['méthode manquante (§ 41)', { allocation_method: undefined }],
      ['montant texte', { amount: 'cent mille' }],
      ['montant décimal', { amount: 1000.5 }],
      ['montant nul', { amount: 0 }],
      ['montant négatif', { amount: -100 }],
      ['montant démesuré', { amount: 1e15 }],
      ['building_id non UUID', { building_id: '123' }],
      ['type inconnu', { charge_type: 'piscine' }],
      ['méthode inconnue', { allocation_method: 'au_hasard' }],
      ['date mal formée', { period_start: '01/09/2026' }],
      ['mois impossible', { period_end: '2026-13-01' }],
      ['période inversée', { period_start: '2026-10-01', period_end: '2026-09-30' }],
      ['fournisseur trop long', { supplier: 'x'.repeat(121) }],
      ['numéro trop long', { invoice_number: 'x'.repeat(61) }],
      ['notes trop longues', { notes: 'x'.repeat(5001) }],
      ['recharge non booléen', { recharge_to_tenants: 'peut-être' }],
    ])('création — %s', async (_cas, surcharges) => {
      const corps = Object.keys(surcharges).length ? corpsFacture(surcharges) : {};
      for (const [k, v] of Object.entries(corps)) if (v === undefined) delete corps[k];
      const avant = await compter('charge_invoices', 'owner_id = :o', { o: p.ownerId });
      const res = await api().post(FC).set(p.h).send(corps);
      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(await compter('charge_invoices', 'owner_id = :o', { o: p.ownerId })).toBe(avant);
    });

    test('immeuble inconnu → 422 ; d’un autre propriétaire → 403', async () => {
      expect((await api().post(FC).set(p.h).send(corpsFacture({ building_id: crypto.randomUUID() }))).status).toBe(422);
      expect((await api().post(FC).set(autre.h).send(corpsFacture())).status).toBe(403);
    });

    test('identifiant de route non UUID → 422 sur chaque route /:id', async () => {
      for (const [m, chemin] of [['get', ''], ['patch', ''], ['get', '/apercu'], ['post', '/apercu'], ['post', '/repartir'], ['post', '/annuler'], ['post', '/document']]) {
        const res = await api()[m](`${FC}/pas-un-uuid${chemin}`).set(p.h).send({ reason: 'Motif valide', amount: 1 });
        expect([m, chemin, res.status]).toEqual([m, chemin, 422]);
      }
      expect((await api().get('/api/v1/charges/1 OR 1=1').set(p.h)).status).toBe(422);
    });

    test('PATCH vide → 422 ; annulation sans motif ou motif trop court/long → 422', async () => {
      const inv = await creerFacture();
      expect((await api().patch(`${FC}/${inv.id}`).set(p.h).send({})).status).toBe(422);
      expect((await api().patch(`${FC}/${inv.id}`).set(p.h).send({ inconnu: 1 })).status).toBe(422);
      expect((await api().post(`${FC}/${inv.id}/annuler`).set(p.h).send({})).status).toBe(422);
      expect((await api().post(`${FC}/${inv.id}/annuler`).set(p.h).send({ reason: 'ab' })).status).toBe(422);
      expect((await api().post(`${FC}/${inv.id}/annuler`).set(p.h).send({ reason: 'x'.repeat(501) })).status).toBe(422);
      expect((await q('SELECT status FROM charge_invoices WHERE id = :id', { id: inv.id }))[0].status).toBe('brouillon');
    });

    test('paramètres de répartition invalides → 422 (lignes, doublons, valeurs, JSON)', async () => {
      const inv = await creerFacture({ allocation_method: 'consommation' });
      const url = `${FC}/${inv.id}/repartir`;
      expect((await api().post(url).set(p.h).send({ lines: [] })).status).toBe(422);
      expect((await api().post(url).set(p.h).send({ lines: [{ apartment_id: 'x', consumption: 1 }] })).status).toBe(422);
      expect((await api().post(url).set(p.h).send({ lines: [{ apartment_id: apts[0].id, consumption: -1 }] })).status).toBe(422);
      expect((await api().post(url).set(p.h).send({ lines: [{ apartment_id: apts[0].id, consumption: 1 }, { apartment_id: apts[0].id, consumption: 2 }] })).status).toBe(422);
      expect((await api().post(url).set(p.h).send({ apartment_ids: [apts[0].id, apts[0].id] })).status).toBe(422);
      expect((await api().post(url).set(p.h).send({ unit: 'x'.repeat(11) })).status).toBe(422);
      // Consommation sans lignes : 422 LIGNES_REQUISES.
      const sansLignes = await api().post(url).set(p.h).send({});
      expect(sansLignes.status).toBe(422);
      expect(sansLignes.body.error.code).toBe('LIGNES_REQUISES');
      // GET : lines doit être du JSON valide.
      expect((await api().get(`${FC}/${inv.id}/apercu`).query({ lines: '{pas du json' }).set(p.h)).status).toBe(422);
      expect((await api().get(`${FC}/${inv.id}/apercu`).query({ apartment_ids: 'a,b' }).set(p.h)).status).toBe(422);
      expect(await compter('charge_allocations', 'charge_invoice_id = :id', { id: inv.id })).toBe(0);
    });
  });

  // ── E / F. Pagination, filtres, recherche, tri ─────────────────────────────
  describe('E/F — pagination, filtres, recherche et tri', () => {
    let proprio;
    let bat1;
    let bat2;
    let factures;

    beforeAll(async () => {
      proprio = await nouveauProprietaire();
      bat1 = await creerImmeuble(proprio);
      bat2 = await creerImmeuble(proprio);
      const base = { charge_type: 'eau', allocation_method: 'egale' };
      const defs = [
        { building_id: bat1.id, supplier: 'SEN’EAU', invoice_number: 'EAU-100%', period_start: '2026-01-01', period_end: '2026-01-31', amount: 3000 },
        { building_id: bat1.id, supplier: 'SENELEC', invoice_number: 'EL_2026', period_start: '2026-02-01', period_end: '2026-02-28', amount: 1000, charge_type: 'electricite' },
        { building_id: bat2.id, supplier: 'Gardien Diallo', invoice_number: 'G-3', period_start: '2026-03-01', period_end: '2026-05-31', amount: 2000, charge_type: 'gardiennage' },
      ];
      factures = [];
      for (const d of defs) {
        factures.push((await api().post(FC).set(proprio.h).send({ ...base, ...d })).body.data.invoice);
      }
      await api().post(`${FC}/${factures[2].id}/annuler`).set(proprio.h).send({ reason: 'Test filtre' });
    });

    const liste = (query) => api().get(FC).query(query).set(proprio.h);

    test('liste vide pour un nouveau propriétaire ; pagination par défaut', async () => {
      const vide = await api().get(FC).set((await nouveauProprietaire()).h);
      expect(vide.status).toBe(200);
      expect(vide.body.data).toEqual({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
    });

    test('pages 1, 2, au-delà ; totaux exacts ; limit plafonnée à 100', async () => {
      const p1 = await liste({ limit: 2, page: 1, tri: 'period_start' });
      expect(p1.body.data.items.map((f) => f.id)).toEqual([factures[0].id, factures[1].id]);
      expect(p1.body.data.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
      const p2 = await liste({ limit: 2, page: 2, tri: 'period_start' });
      expect(p2.body.data.items.map((f) => f.id)).toEqual([factures[2].id]);
      const au_dela = await liste({ limit: 2, page: 9 });
      expect(au_dela.body.data.items).toEqual([]);
      expect(au_dela.body.data.pagination.total).toBe(3);
      expect((await liste({ limit: 1000 })).body.data.pagination.limit).toBe(100);
    });

    test.each([[{ page: 0 }], [{ page: -1 }], [{ limit: 0 }], [{ limit: -5 }], [{ page: 'abc' }], [{ tri: 'owner_id' }], [{ tri: 'amount; DROP TABLE x' }],
      [{ status: 'payee' }], [{ charge_type: 'x' }], [{ building_id: 'x' }], [{ du: '2026-02-30x' }], [{ q: 'x'.repeat(101) }]])('paramètre invalide %j → 422', async (query) => {
      expect((await liste(query)).status).toBe(422);
    });

    test('filtres : immeuble, statut, type, chevauchement de période', async () => {
      const ids = async (query) => (await liste(query)).body.data.items.map((f) => f.id).sort();
      expect(await ids({ building_id: bat1.id })).toEqual([factures[0].id, factures[1].id].sort());
      expect(await ids({ status: 'annulee' })).toEqual([factures[2].id]);
      expect(await ids({ charge_type: 'electricite' })).toEqual([factures[1].id]);
      // Chevauchement : [2026-02-15, 2026-04-01] touche février et mars-mai.
      expect(await ids({ du: '2026-02-15', au: '2026-04-01' })).toEqual([factures[1].id, factures[2].id].sort());
      expect(await ids({ au: '2025-12-31' })).toEqual([]);
    });

    test('tri croissant / décroissant sur le montant', async () => {
      const montants = async (tri) => (await liste({ tri })).body.data.items.map((f) => f.amount);
      expect(await montants('amount')).toEqual([1000, 2000, 3000]);
      expect(await montants('-amount')).toEqual([3000, 2000, 1000]);
    });

    test('recherche : fournisseur ou numéro, jokers échappés, injections inoffensives', async () => {
      const ids = async (terme) => (await liste({ q: terme })).body.data.items.map((f) => f.id);
      expect(await ids('senelec')).toEqual([factures[1].id]);
      expect(await ids('100%')).toEqual([factures[0].id]);
      expect(await ids('EL_')).toEqual([factures[1].id]);
      expect(await ids('%')).toEqual([factures[0].id]);
      for (const terme of INJECTIONS) {
        const res = await liste({ q: terme });
        expect(res.status).toBe(200);
        expect(res.body.data.items.every((f) => f.owner_id === proprio.ownerId)).toBe(true);
      }
      expect(await compter('charge_invoices', 'owner_id = :o', { o: proprio.ownerId })).toBe(3);
    });
  });

  // ── G. Règles métier : méthodes de répartition ─────────────────────────────
  describe('G — méthodes de répartition (§ 16, § 17), arrondis exacts, explication conservée', () => {
    const repartir = async (surcharges, corps = {}) => {
      const inv = await creerFacture(surcharges);
      const res = await api().post(`${FC}/${inv.id}/repartir`).set(p.h).send(corps);
      return { inv, res };
    };
    const lignesEnBase = (id) => q(`
      SELECT a.number, ca.basis_value, ca.share, ca.amount, ca.explanation, ca.lease_id
        FROM charge_allocations ca JOIN apartments a ON a.id = ca.apartment_id
       WHERE ca.charge_invoice_id = :id ORDER BY a.number`, { id });

    test('égale avec reste d’arrondi : 100 001 / 3 → 33 334 + 33 334 + 33 333, somme exacte, explication de l’arrondi', async () => {
      const { inv, res } = await repartir({ amount: 100001 });
      expect(res.status).toBe(200);
      const lignes = await lignesEnBase(inv.id);
      expect(lignes.map((l) => l.amount)).toEqual([33334, 33334, 33333]);
      expect(lignes.reduce((s, l) => s + l.amount, 0)).toBe(100001);
      expect(lignes[2].explanation).toMatch(/100 001 FCFA ÷ 3 appartements = 33 333,67 FCFA, arrondi à 33 333 FCFA/);
      expect(lignes.every((l) => Number(l.basis_value) === 1)).toBe(true);
    });

    test('consommation avec unité personnalisée : parts proportionnelles, somme exacte, base conservée', async () => {
      const { inv, res } = await repartir({ amount: 70000, allocation_method: 'consommation', charge_type: 'eau' }, {
        unit: 'm³', lines: [{ apartment_id: apts[0].id, consumption: 12.5 }, { apartment_id: apts[1].id, consumption: 7.5 }, { apartment_id: apts[2].id, consumption: 0 }],
      });
      expect(res.status).toBe(200);
      const lignes = await lignesEnBase(inv.id);
      expect(lignes.map((l) => [l.number, l.amount])).toEqual([['B1', 43750], ['B2', 26250], ['B3', 0]]);
      expect(lignes[0].explanation).toBe('12,5 m³ sur 20 m³ (62,50 %) de 70 000 FCFA = 43 750 FCFA');
      expect(lignes[2].explanation).toMatch(/aucune part, 0 FCFA/);
      expect(Number(lignes[0].basis_value)).toBe(12.5);
      // Une part nulle ne crée pas de charge (B3 est de toute façon vacant).
      expect(await compter('charges', 'charge_invoice_id = :id', { id: inv.id })).toBe(2);
    });

    test('coefficient avec surcharge ponctuelle : B3 porté à 5 → 3 / 2 / 5 sur 10', async () => {
      const { inv, res } = await repartir({ amount: 50000, allocation_method: 'coefficient' }, { lines: [{ apartment_id: apts[2].id, coefficient: 5 }] });
      expect(res.status).toBe(200);
      expect((await lignesEnBase(inv.id)).map((l) => l.amount)).toEqual([15000, 10000, 25000]);
    });

    test('occupants : bail sur la période (4 et 1), vacant 0 ; surcharge d’occupants pour le vacant', async () => {
      const { inv, res } = await repartir({ amount: 10000, allocation_method: 'occupants' });
      expect(res.status).toBe(200);
      const lignes = await lignesEnBase(inv.id);
      expect(lignes.map((l) => l.amount)).toEqual([8000, 2000, 0]);
      expect(lignes[2].explanation).toMatch(/logement vacant/);
      expect(lignes[2].lease_id).toBeNull();

      const surcharge = await repartir({ amount: 10000, allocation_method: 'occupants' }, { lines: [{ apartment_id: apts[2].id, occupants: 5 }] });
      expect((await lignesEnBase(surcharge.inv.id)).map((l) => l.amount)).toEqual([4000, 1000, 5000]);
    });

    test('personnalisé : somme exacte acceptée ; somme différente → 422 avec l’écart, rien d’écrit (H)', async () => {
      const inv = await creerFacture({ amount: 10000, allocation_method: 'personnalise' });
      const faux = await api().post(`${FC}/${inv.id}/repartir`).set(p.h).send({ lines: [{ apartment_id: apts[0].id, amount: 6000 }, { apartment_id: apts[1].id, amount: 3000 }] });
      expect(faux.status).toBe(422);
      expect(faux.body.error.code).toBe('SOMME_DIFFERENTE_DU_TOTAL');
      expect(faux.body.error.details[0]).toMatch(/écart : -1 000 FCFA/);
      expect(await compter('charge_allocations', 'charge_invoice_id = :id', { id: inv.id })).toBe(0);
      expect(await compter('charges', 'charge_invoice_id = :id', { id: inv.id })).toBe(0);
      expect(await compter('audit_logs', "entity_id = :id AND action = 'facture_commune.repartition'", { id: inv.id })).toBe(0);
      expect((await q('SELECT status, allocated_at FROM charge_invoices WHERE id = :id', { id: inv.id }))[0]).toEqual({ status: 'brouillon', allocated_at: null });

      const bon = await api().post(`${FC}/${inv.id}/repartir`).set(p.h).send({ lines: [{ apartment_id: apts[0].id, amount: 7000 }, { apartment_id: apts[1].id, amount: 3000 }] });
      expect(bon.status).toBe(200);
      expect((await lignesEnBase(inv.id)).map((l) => l.explanation)).toEqual([
        'Montant personnalisé : 7 000 FCFA (70,00 % de 10 000 FCFA)', 'Montant personnalisé : 3 000 FCFA (30,00 % de 10 000 FCFA)',
      ]);
    });

    test('sans refacturation (recharge_to_tenants = false) : lignes tracées, AUCUNE charge ni notification', async () => {
      const { inv, res } = await repartir({ recharge_to_tenants: false, amount: 30000 });
      expect(res.status).toBe(200);
      expect(res.body.data.invoice.recharged_total).toBe(0);
      expect(await compter('charge_allocations', 'charge_invoice_id = :id', { id: inv.id })).toBe(3);
      expect(await compter('charges', 'charge_invoice_id = :id', { id: inv.id })).toBe(0);
      expect(await compter('notifications', "data->>'charge_invoice_id' = :id", { id: inv.id })).toBe(0);
    });

    test('immeuble sans appartement → 422 AUCUN_APPARTEMENT, facture intacte', async () => {
      const inv = await creerFacture({ building_id: immeubleVide.id });
      const res = await api().post(`${FC}/${inv.id}/repartir`).set(p.h).send({});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('AUCUN_APPARTEMENT');
      expect((await q('SELECT status FROM charge_invoices WHERE id = :id', { id: inv.id }))[0].status).toBe('brouillon');
    });

    test('ligne présente dans lines mais absente de apartment_ids → 422 APPARTEMENT_HORS_SELECTION', async () => {
      const inv = await creerFacture({ allocation_method: 'coefficient' });
      const res = await api().post(`${FC}/${inv.id}/repartir`).set(p.h).send({ apartment_ids: [apts[0].id], lines: [{ apartment_id: apts[1].id, coefficient: 1 }] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('APPARTEMENT_HORS_SELECTION');
    });
  });

  // ── I. Concurrence ─────────────────────────────────────────────────────────
  describe('I — concurrence', () => {
    test('deux « répartir » simultanés sur la même facture → un seul jeu de lignes et de charges', async () => {
      const inv = await creerFacture({ amount: 30000 });
      const reponses = await Promise.all([1, 2, 3].map(() => api().post(`${FC}/${inv.id}/repartir`).set(p.h).send({})));
      const statuts = reponses.map((r) => r.status).sort();
      expect(statuts).toEqual([200, 409, 409]);
      expect(reponses.filter((r) => r.status === 409).every((r) => r.body.error.code === 'FACTURE_DEJA_REPARTIE')).toBe(true);
      expect(await compter('charge_allocations', 'charge_invoice_id = :id', { id: inv.id })).toBe(3);
      expect(await compter('charges', 'charge_invoice_id = :id', { id: inv.id })).toBe(2);
      expect(await compter('audit_logs', "entity_id = :id AND action = 'facture_commune.repartition'", { id: inv.id })).toBe(1);
    });

    test('répartition et annulation simultanées : état final cohérent (jamais des charges vivantes sur une facture annulée)', async () => {
      const inv = await creerFacture({ amount: 30000 });
      await Promise.all([
        api().post(`${FC}/${inv.id}/repartir`).set(p.h).send({}),
        api().post(`${FC}/${inv.id}/annuler`).set(p.h).send({ reason: 'Course' }),
      ]);
      const [f] = await q('SELECT status FROM charge_invoices WHERE id = :id', { id: inv.id });
      const vivantes = await compter('charges', "charge_invoice_id = :id AND status <> 'annule'", { id: inv.id });
      if (f.status === 'annulee') expect(vivantes).toBe(0);
      else expect(f.status).toBe('repartie');
    });
  });

  // ── C. Cloisonnement ───────────────────────────────────────────────────────
  describe('C — autre propriétaire : 403 sans modification', () => {
    test('chaque route /:id de la facture d’autrui → 403 et la facture reste identique', async () => {
      const inv = await creerFacture();
      const [avant] = await q('SELECT * FROM charge_invoices WHERE id = :id', { id: inv.id });
      const essais = [
        api().get(`${FC}/${inv.id}`).set(autre.h),
        api().patch(`${FC}/${inv.id}`).set(autre.h).send({ amount: 1 }),
        api().get(`${FC}/${inv.id}/apercu`).set(autre.h),
        api().post(`${FC}/${inv.id}/apercu`).set(autre.h).send({}),
        api().post(`${FC}/${inv.id}/repartir`).set(autre.h).send({}),
        api().post(`${FC}/${inv.id}/annuler`).set(autre.h).send({ reason: 'Pirate' }),
        api().post(`${FC}/${inv.id}/document`).set(autre.h).attach('fichier', PDF, 'x.pdf'),
      ];
      for (const res of await Promise.all(essais)) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ACCES_AUTRE_PROPRIETAIRE');
      }
      const [apres] = await q('SELECT * FROM charge_invoices WHERE id = :id', { id: inv.id });
      expect(apres).toEqual(avant);
      expect(await compter('documents', 'entity_id = :id', { id: inv.id })).toBe(0);
      expect((await api().get(`${FC}/${crypto.randomUUID()}`).set(p.h)).status).toBe(404);
      expect((await api().post(`${FC}/${crypto.randomUUID()}/repartir`).set(p.h).send({})).status).toBe(404);
    });
  });

  // ── Charges (propriétaire) et « Mes charges » (locataire) ──────────────────
  describe('/charges et /locataire/charges', () => {
    let inv;
    let chargeB1;
    let chargeB2;

    beforeAll(async () => {
      inv = await creerFacture({ amount: 45000, invoice_number: 'MES-CHARGES' });
      await api().post(`${FC}/${inv.id}/repartir`).set(p.h).send({});
      [chargeB1] = await q('SELECT * FROM charges WHERE charge_invoice_id = :id AND apartment_id = :a', { id: inv.id, a: apts[0].id });
      [chargeB2] = await q('SELECT * FROM charges WHERE charge_invoice_id = :id AND apartment_id = :a', { id: inv.id, a: apts[1].id });
    });

    test('liste propriétaire : filtres facture, locataire, appartement, immeuble, statut, période ; forme', async () => {
      const ids = async (query) => (await api().get('/api/v1/charges').query(query).set(p.h)).body.data.items.map((c) => c.id).sort();
      expect(await ids({ charge_invoice_id: inv.id })).toEqual([chargeB1.id, chargeB2.id].sort());
      expect(await ids({ charge_invoice_id: inv.id, tenant_id: tenants[0].id })).toEqual([chargeB1.id]);
      expect(await ids({ charge_invoice_id: inv.id, apartment_id: apts[1].id })).toEqual([chargeB2.id]);
      expect(await ids({ charge_invoice_id: inv.id, building_id: immeuble.id })).toHaveLength(2);
      expect(await ids({ charge_invoice_id: inv.id, building_id: immeubleVide.id })).toEqual([]);
      expect(await ids({ charge_invoice_id: inv.id, status: 'paye' })).toEqual([]);
      expect(await ids({ charge_invoice_id: inv.id, du: '2026-10-20', au: '2026-10-20' })).toHaveLength(2);
      expect(await ids({ charge_invoice_id: inv.id, lease_id: chargeB1.lease_id })).toEqual([chargeB1.id]);
      const res = await api().get('/api/v1/charges').query({ charge_invoice_id: inv.id, tri: '-amount', limit: 1 }).set(p.h);
      expect(res.body.data.pagination).toMatchObject({ total: 2, limit: 1, totalPages: 2 });
      expect(res.body.data.items[0]).toMatchObject({
        tenant: { id: expect.any(String) }, apartment: { building: { name: 'Résidence Baobab' } }, invoice: { id: inv.id, invoice_number: 'MES-CHARGES' },
      });
      for (const query of [{ tri: 'tenant_id' }, { status: 'x' }, { lease_id: 'x' }, { page: 0 }, { limit: 0 }]) {
        expect((await api().get('/api/v1/charges').query(query).set(p.h)).status).toBe(422);
      }
      expect((await api().get('/api/v1/charges').query({ limit: 500 }).set(p.h)).body.data.pagination.limit).toBe(100);
    });

    test('détail propriétaire : reste dû et explication ; autre propriétaire 403 ; inconnue 404', async () => {
      const res = await api().get(`/api/v1/charges/${chargeB1.id}`).set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.charge).toMatchObject({ id: chargeB1.id, remaining: 15000, allocation: { explanation: '45 000 FCFA ÷ 3 appartements = 15 000 FCFA' } });
      expect((await api().get(`/api/v1/charges/${chargeB1.id}`).set(autre.h)).status).toBe(403);
      expect((await api().get(`/api/v1/charges/${crypto.randomUUID()}`).set(p.h)).status).toBe(404);
    });

    test('« Mes charges » : SA part seulement, filtre statut, tri, pagination ; détail sans données d’autrui', async () => {
      const liste = await api().get('/api/v1/locataire/charges').set(comptes[0].h);
      expect(liste.status).toBe(200);
      const miennes = await q('SELECT id FROM charges WHERE tenant_id = :t', { t: tenants[0].id });
      expect(liste.body.data.pagination.total).toBe(miennes.length);
      expect(liste.body.data.items.map((c) => c.id)).toContain(chargeB1.id);
      expect(liste.body.data.items.map((c) => c.id)).not.toContain(chargeB2.id);
      expect(JSON.stringify(liste.body)).not.toContain(tenants[1].id);
      expect((await api().get('/api/v1/locataire/charges').query({ status: 'paye' }).set(comptes[0].h)).body.data.items).toEqual([]);
      expect((await api().get('/api/v1/locataire/charges').query({ limit: 1, page: 1, tri: 'amount' }).set(comptes[0].h)).body.data.items).toHaveLength(1);
      for (const query of [{ status: 'x' }, { tri: 'owner_id' }, { page: 0 }, { limit: 0 }]) {
        expect((await api().get('/api/v1/locataire/charges').query(query).set(comptes[0].h)).status).toBe(422);
      }

      const detail = await api().get(`/api/v1/locataire/charges/${chargeB1.id}`).set(comptes[0].h);
      expect(detail.status).toBe(200);
      expect(detail.body.data.charge).toMatchObject({
        id: chargeB1.id, amount: 15000, remaining: 15000, apartment: { number: 'B1' },
        calculation: { method: 'egale', invoice_total: 45000, apartments_count: 3, invoice_number: 'MES-CHARGES' },
      });
      expect(JSON.stringify(detail.body)).not.toMatch(/owner_id|notes|"B2"/);

      // Charge d'un autre locataire → 403 ; inconnue → 404 ; id invalide → 422.
      expect((await api().get(`/api/v1/locataire/charges/${chargeB2.id}`).set(comptes[0].h)).status).toBe(403);
      expect((await api().get(`/api/v1/locataire/charges/${crypto.randomUUID()}`).set(comptes[0].h)).status).toBe(404);
      expect((await api().get('/api/v1/locataire/charges/abc').set(comptes[0].h)).status).toBe(422);
    });

    test('charge annulée : reste dû 0 côté locataire', async () => {
      const f = await creerFacture({ amount: 20000 });
      await api().post(`${FC}/${f.id}/repartir`).set(p.h).send({});
      await api().post(`${FC}/${f.id}/annuler`).set(p.h).send({ reason: 'Annulation test' });
      const [c] = await q('SELECT id FROM charges WHERE charge_invoice_id = :id AND tenant_id = :t', { id: f.id, t: tenants[0].id });
      const detail = await api().get(`/api/v1/locataire/charges/${c.id}`).set(comptes[0].h);
      expect(detail.body.data.charge).toMatchObject({ status: 'annule', remaining: 0 });
    });
  });
});
