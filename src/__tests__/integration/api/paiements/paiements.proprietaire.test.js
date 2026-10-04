'use strict';

const crypto = require('crypto');
const {
  api, nouveauProprietaire, superAdmin, bailActif, activerLocataire, fermer, sequelize, compter,
  desactiverEdlObligatoire, creerImmeuble, creerAppartement, creerLocataire, payerEspeces,
} = require('../../../setup/helpers.js');
const {
  UUID_ABSENT, simulerFournisseurs, echeancesDu, preparerPaydunya, initier, ipn, enFormulaire, soldeCaisse, ligne, lignes,
  verifierAuthentification, verifierCompteDesactive, revoquerSessions, restreindrePermissions, PAYDUNYA,
} = require('./outils.paiements.js');

/**
 * API propriétaire des paiements (§ 12, § 13, § 21, § 41, § 44, § 51.4, § 51.5) :
 *   POST /paiements/especes · GET /paiements · GET /paiements/:id
 *   GET /paiements/:id/quittances · POST /paiements/:id/rembourser
 *   GET /paiements/moyens · PUT /paiements/moyens
 */

const especes = (p, corps, entetes = {}) => api().post('/api/v1/paiements/especes').set(p.h).set(entetes).send(corps);

describe('Paiements — espace propriétaire', () => {
  let fournisseurs;
  beforeAll(() => { fournisseurs = simulerFournisseurs(); });
  afterAll(async () => {
    fournisseurs.restaurer();
    await fermer();
  });

  describe('authentification et autorisations (toutes les routes)', () => {
    const routes = [
      ['POST', '/api/v1/paiements/especes', { lease_id: UUID_ABSENT, amount: 1000, paid_on: '2026-09-05' }],
      ['GET', '/api/v1/paiements', null],
      ['GET', `/api/v1/paiements/${UUID_ABSENT}`, null],
      ['GET', `/api/v1/paiements/${UUID_ABSENT}/quittances`, null],
      ['POST', `/api/v1/paiements/${UUID_ABSENT}/rembourser`, { reason: 'Erreur de saisie' }],
      ['GET', '/api/v1/paiements/moyens', null],
      ['PUT', '/api/v1/paiements/moyens', { provider: 'wave', mode: 'preuve', account_number: '771112233' }],
    ];

    test.each(routes)('%s %s : sans jeton, jeton falsifié, expiré, de rafraîchissement ou révoqué → 401', async (methode, url, corps) => {
      const p = await nouveauProprietaire();
      await verifierAuthentification(methode, url, p, corps);
    });

    test('compte désactivé → 403 COMPTE_INACTIF sur chaque route ; session réellement révoquée → 401', async () => {
      const p = await nouveauProprietaire();
      const ancien = p.h;
      await revoquerSessions(p.user.id);
      const res = await api().get('/api/v1/paiements').set(ancien);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_REVOQUEE');
      await verifierCompteDesactive(routes, p);
    });

    test('un locataire ou un super admin n’accède pas à l’espace propriétaire (403)', async () => {
      const p = await nouveauProprietaire();
      const { tenant } = await bailActif(p);
      const loc = await activerLocataire(p, tenant);
      const admin = await superAdmin();
      for (const [methode, url, corps] of routes) {
        for (const compte of [loc, admin]) {
          const r = api()[methode.toLowerCase()](url).set(compte.h);
          const res = methode === 'GET' ? await r : await r.send(corps);
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('ESPACE_PROPRIETAIRE_REQUIS');
        }
      }
    });

    test('permission manquante : un rôle en lecture seule lit mais ne peut ni encaisser, ni rembourser, ni configurer (403 PERMISSION_REFUSEE)', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const pay = await payerEspeces(p, lease.id, 1000);
      await restreindrePermissions(p, ['paiements.lire']);
      expect((await api().get('/api/v1/paiements').set(p.h)).status).toBe(200);
      expect((await api().get(`/api/v1/paiements/${pay.payment.id}`).set(p.h)).status).toBe(200);
      for (const res of [
        await especes(p, { lease_id: lease.id, amount: 1000, paid_on: '2026-09-05' }),
        await api().post(`/api/v1/paiements/${pay.payment.id}/rembourser`).set(p.h).send({ reason: 'Erreur' }),
        await api().get(`/api/v1/paiements/${pay.payment.id}/quittances`).set(p.h),
        await api().get('/api/v1/paiements/moyens').set(p.h),
        await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'preuve', account_number: '771112233' }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('PERMISSION_REFUSEE');
      }
      expect(await compter('rent_payments', 'lease_id = :l', { l: lease.id })).toBe(1);
    });

    test('abonnement échu : lecture possible, encaissement refusé (402 ABONNEMENT_REQUIS)', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      await require('../../../setup/helpers.js').expirerAbonnement(p.ownerId);
      expect((await api().get('/api/v1/paiements').set(p.h)).status).toBe(200);
      const res = await especes(p, { lease_id: lease.id, amount: 1000, paid_on: '2026-09-05' });
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe('ABONNEMENT_REQUIS');
    });
  });

  describe('POST /paiements/especes', () => {
    test('nominal : forme de la réponse, imputation, notification au locataire, journal et caisse', async () => {
      const p = await nouveauProprietaire();
      const { lease, tenant, apartment } = await bailActif(p);
      const loc = await activerLocataire(p, tenant);
      const [sept] = await echeancesDu(p, lease.id);
      const res = await especes(p, { lease_id: lease.id, rent_schedule_id: sept.id, amount: 350000, paid_on: '2026-09-23', method: 'virement', reference: 'VIR-2026/09.001', comment: 'Virement bancaire' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, message: 'Paiement enregistré' });
      expect(res.body.data.payment).toMatchObject({
        owner_id: p.ownerId, tenant_id: tenant.id, lease_id: lease.id, apartment_id: apartment.id,
        amount: 350000, method: 'virement', paid_on: '2026-09-23', reference: 'VIR-2026/09.001', comment: 'Virement bancaire', status: 'valide', recorded_by: p.user.id,
      });
      expect(res.body.data.allocations).toEqual([expect.objectContaining({ rent_schedule_id: sept.id, amount: 350000 })]);
      expect(res.body.data.receipts).toEqual([expect.objectContaining({ rent_schedule_id: sept.id, amount: 350000, payment_references: ['VIR-2026/09.001'] })]);
      expect(res.body.data.receipts[0].number).toMatch(/^QUI-\d{4}-\d{5}$/);

      const e = await ligne('SELECT status, amount_paid, paid_at FROM rent_schedules WHERE id = :id', { id: sept.id });
      expect(e).toMatchObject({ status: 'paye', amount_paid: 350000 });
      expect(e.paid_at).not.toBeNull();
      const [mvt] = await lignes('SELECT direction, category, amount, method, source_type FROM cash_movements WHERE source_id = :id', { id: res.body.data.payment.id });
      expect(mvt).toEqual({ direction: 'entree', category: 'loyer', amount: 350000, method: 'virement', source_type: 'rent_payment' });
      const notif = await ligne("SELECT title, body FROM notifications WHERE user_id = :u AND type = 'nouveau_paiement'", { u: loc.user.id });
      expect(notif.title).toBe('Paiement confirmé');
      expect(notif.body).toContain('VIR-2026/09.001');
      const audit = await ligne("SELECT details FROM audit_logs WHERE action = 'paiement.paiement' AND entity_id = :id", { id: res.body.data.payment.id });
      expect(audit.details).toMatchObject({ montant: 350000, methode: 'virement', lease_id: lease.id });
    });

    test('affectation de masse ignorée : owner_id, status, amount_paid fournis par le client sont retirés', async () => {
      const p = await nouveauProprietaire();
      const autre = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const res = await especes(p, { lease_id: lease.id, amount: 1000, paid_on: '2026-09-05', owner_id: autre.ownerId, status: 'rembourse', recorded_by: autre.user.id });
      expect(res.status).toBe(201);
      expect(res.body.data.payment).toMatchObject({ owner_id: p.ownerId, status: 'valide', recorded_by: p.user.id });
    });

    test.each([
      ['corps vide', {}, false],
      ['bail manquant', { amount: 1000, paid_on: '2026-09-05' }, false],
      ['bail non UUID', { lease_id: 'abc', amount: 1000, paid_on: '2026-09-05' }, false],
      ['montant manquant', { paid_on: '2026-09-05' }],
      ['montant négatif', { amount: -5000, paid_on: '2026-09-05' }],
      ['montant nul', { amount: 0, paid_on: '2026-09-05' }],
      ['montant décimal', { amount: 1000.5, paid_on: '2026-09-05' }],
      ['montant texte', { amount: 'mille', paid_on: '2026-09-05' }],
      ['montant démesuré', { amount: 1e15, paid_on: '2026-09-05' }],
      ['date manquante', { amount: 1000 }],
      ['date invalide', { amount: 1000, paid_on: '2026-13-01' }],
      ['date au mauvais format', { amount: 1000, paid_on: '05/09/2026' }],
      ['date inexistante (2026-02-30, 500 PostgreSQL avant correctif)', { amount: 1000, paid_on: '2026-02-30' }],
      ['date future (argent pas encore reçu)', { amount: 1000, paid_on: '2099-01-01' }],
      ['mode inconnu', { amount: 1000, paid_on: '2026-09-05', method: 'bitcoin' }],
      ['référence trop longue', { amount: 1000, paid_on: '2026-09-05', reference: 'R'.repeat(41) }],
      ['référence à caractères spéciaux', { amount: 1000, paid_on: '2026-09-05', reference: '<script>' }],
      ['commentaire trop long', { amount: 1000, paid_on: '2026-09-05', comment: 'x'.repeat(1001) }],
      ['échéance ET charge', { amount: 1000, paid_on: '2026-09-05', rent_schedule_id: UUID_ABSENT, charge_id: UUID_ABSENT }],
      ['échéance non UUID', { amount: 1000, paid_on: '2026-09-05', rent_schedule_id: '1 OR 1=1' }],
    ])('validation — %s → 422, rien n’est enregistré', async (_libelle, corps, avecBail = true) => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const res = await especes(p, avecBail ? { lease_id: lease.id, ...corps } : corps);
      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('DONNEES_INVALIDES');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('bail inexistant → 422 ; bail d’un autre propriétaire → 403 ; échéance d’un autre bail → 422', async () => {
      const a = await nouveauProprietaire();
      const b = await nouveauProprietaire();
      const bailA = await bailActif(a);
      const bailA2 = await bailActif(a);
      const bailB = await bailActif(b);
      const inexistant = await especes(a, { lease_id: UUID_ABSENT, amount: 1000, paid_on: '2026-09-05' });
      expect(inexistant.status).toBe(422);
      const autre = await especes(a, { lease_id: bailB.lease.id, amount: 1000, paid_on: '2026-09-05' });
      expect(autre.status).toBe(403);
      expect(autre.body.error.code).toBe('ACCES_AUTRE_PROPRIETAIRE');
      const [septA2] = await echeancesDu(a, bailA2.lease.id);
      const croise = await especes(a, { lease_id: bailA.lease.id, rent_schedule_id: septA2.id, amount: 1000, paid_on: '2026-09-05' });
      expect(croise.status).toBe(422);
      expect(await compter('rent_payments', 'owner_id IN (:o)', { o: [a.ownerId, b.ownerId] })).toBe(0);
    });

    test('référence déjà utilisée → 409 REFERENCE_EXISTANTE', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      expect((await especes(p, { lease_id: lease.id, amount: 1000, paid_on: '2026-09-05', reference: 'CHQ-0001' })).status).toBe(201);
      const doublon = await especes(p, { lease_id: lease.id, amount: 1000, paid_on: '2026-09-05', reference: 'CHQ-0001' });
      expect(doublon.status).toBe(409);
      expect(doublon.body.error.code).toBe('REFERENCE_EXISTANTE');
    });

    test('références générées PAY-AAAAMMJJ-NNN : séquentielles par jour et par propriétaire', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const refs = [];
      for (let i = 0; i < 3; i += 1) refs.push((await payerEspeces(p, lease.id, 1000, { paidOn: '2026-09-07' })).payment.reference);
      expect(refs).toEqual(['PAY-20260907-001', 'PAY-20260907-002', 'PAY-20260907-003']);
      expect((await payerEspeces(p, lease.id, 1000, { paidOn: '2026-09-08' })).payment.reference).toBe('PAY-20260908-001');
    });

    test('bail en brouillon → 409 BAIL_INVALIDE ; bail terminé (solde de sortie) → accepté', async () => {
      const p = await nouveauProprietaire();
      await desactiverEdlObligatoire(p);
      const immeuble = await creerImmeuble(p);
      const appart = await creerAppartement(p, immeuble.id);
      const loc = await creerLocataire(p);
      const brouillon = (await api().post('/api/v1/baux').set(p.h).send({ apartment_id: appart.id, tenant_id: loc.id, start_date: '2026-09-01', rent_amount: 100000, deposit_amount: 0, due_day: 5 })).body.data.lease;
      const refus = await especes(p, { lease_id: brouillon.id, amount: 1000, paid_on: '2026-09-05' });
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('BAIL_INVALIDE');

      const { lease } = await bailActif(p);
      await sequelize.query("UPDATE leases SET status = 'termine' WHERE id = :l", { replacements: { l: lease.id } });
      expect((await especes(p, { lease_id: lease.id, amount: 1000, paid_on: '2026-09-05' })).status).toBe(201);
    });

    test('§ 41 échéance annulée → 409 ECHEANCE_ANNULEE et AUCUNE ligne partielle (paiement, imputation, caisse, quittance)', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      expect((await api().post(`/api/v1/echeances/${sept.id}/annuler`).set(p.h).send({ reason: 'Geste commercial' })).status).toBe(200);
      const res = await especes(p, { lease_id: lease.id, rent_schedule_id: sept.id, amount: 350000, paid_on: '2026-09-05' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ECHEANCE_ANNULEE');
      for (const table of ['rent_payments', 'payment_allocations', 'cash_movements', 'receipts']) {
        expect(await compter(table, 'owner_id = :o', { o: p.ownerId })).toBe(0);
      }
    });

    test('transaction : excédent au-delà de tout le dû (erreur APRÈS l’insertion du paiement et des imputations) → aucune ligne partielle, soldes intacts', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p, { bail: { end_date: '2026-10-31' } });
      const [sept, oct] = await echeancesDu(p, lease.id);
      const res = await especes(p, { lease_id: lease.id, rent_schedule_id: sept.id, amount: 700001, paid_on: '2026-09-05' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('MONTANT_SUPERIEUR_AU_DU');
      expect(res.body.error.details[0]).toContain('1');
      for (const table of ['rent_payments', 'payment_allocations', 'cash_movements', 'receipts', 'documents']) {
        expect(await compter(table, 'owner_id = :o', { o: p.ownerId })).toBe(0);
      }
      expect(await lignes('SELECT amount_paid FROM rent_schedules WHERE id IN (:ids) ORDER BY due_date', { ids: [sept.id, oct.id] })).toEqual([{ amount_paid: 0 }, { amount_paid: 0 }]);
      // Le compteur de références a aussi été annulé : la prochaine est -001.
      expect((await payerEspeces(p, lease.id, 1000, { paidOn: '2026-09-05' })).payment.reference).toBe('PAY-20260905-001');
    });

    test('échéance déjà payée ciblée : le montant va à l’échéance ouverte suivante (FIFO)', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept, oct] = await echeancesDu(p, lease.id);
      await payerEspeces(p, lease.id, 350000, { scheduleId: sept.id });
      const res = await especes(p, { lease_id: lease.id, rent_schedule_id: sept.id, amount: 100000, paid_on: '2026-09-06' });
      expect(res.status).toBe(201);
      expect(res.body.data.allocations).toEqual([expect.objectContaining({ rent_schedule_id: oct.id, amount: 100000 })]);
      expect(res.body.data.receipts).toHaveLength(0);
    });

    test('paiement non ciblé : imputé de la plus ancienne à la plus récente échéance', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept, oct, nov] = await echeancesDu(p, lease.id);
      const res = await especes(p, { lease_id: lease.id, amount: 800000, paid_on: '2026-09-06' });
      expect(res.body.data.allocations.map((a) => [a.rent_schedule_id, a.amount])).toEqual([[sept.id, 350000], [oct.id, 350000], [nov.id, 100000]]);
      expect(res.body.data.receipts).toHaveLength(2);
    });

    test('concurrence : deux encaissements simultanés dépassant le dû d’une échéance unique → un seul passe, amount_paid ≤ amount_due', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p, { bail: { end_date: '2026-09-30' } });
      const [sept] = await echeancesDu(p, lease.id);
      const corps = { lease_id: lease.id, rent_schedule_id: sept.id, amount: 300000, paid_on: '2026-09-05' };
      const reponses = await Promise.all([especes(p, corps), especes(p, corps)]);
      expect(reponses.map((r) => r.status).sort()).toEqual([201, 422]);
      const e = await ligne('SELECT amount_due, amount_paid FROM rent_schedules WHERE id = :id', { id: sept.id });
      expect(e.amount_paid).toBe(300000);
      expect(e.amount_paid).toBeLessThanOrEqual(e.amount_due);
      expect(await compter('rent_payments', 'lease_id = :l', { l: lease.id })).toBe(1);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 300000, sorties: 0 });
    });

    test('concurrence : cinq encaissements simultanés sur la même échéance → totaux cohérents (imputations = soldes = caisse)', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      const reponses = await Promise.all(Array.from({ length: 5 }, () => especes(p, { lease_id: lease.id, rent_schedule_id: sept.id, amount: 200000, paid_on: '2026-09-05' })));
      expect(reponses.every((r) => r.status === 201)).toBe(true);
      const { allocs } = await ligne('SELECT COALESCE(sum(amount), 0)::int AS allocs FROM payment_allocations WHERE owner_id = :o AND reversed_at IS NULL', { o: p.ownerId });
      const { payes } = await ligne('SELECT sum(amount_paid)::int AS payes FROM rent_schedules WHERE lease_id = :l', { l: lease.id });
      const depassements = await compter('rent_schedules', 'lease_id = :l AND amount_paid > amount_due', { l: lease.id });
      expect(allocs).toBe(1000000);
      expect(payes).toBe(1000000);
      expect(depassements).toBe(0);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 1000000, sorties: 0 });
      expect(await compter('receipts', 'lease_id = :l AND cancelled_at IS NULL', { l: lease.id })).toBe(2);
    });

    test('§ 44 double clic avec la même clé : clé d’idempotence invalide → 422 ; clé réutilisée pour un autre corps → 422', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const invalide = await especes(p, { lease_id: lease.id, amount: 1000, paid_on: '2026-09-05' }, { 'Idempotency-Key': 'court' });
      expect(invalide.status).toBe(422);
      expect(invalide.body.error.code).toBe('IDEMPOTENCE_INVALIDE');
      const cle = crypto.randomUUID();
      expect((await especes(p, { lease_id: lease.id, amount: 1000, paid_on: '2026-09-05' }, { 'Idempotency-Key': cle })).status).toBe(201);
      const autre = await especes(p, { lease_id: lease.id, amount: 2000, paid_on: '2026-09-05' }, { 'Idempotency-Key': cle });
      expect(autre.status).toBe(422);
      expect(autre.body.error.code).toBe('IDEMPOTENCE_REUTILISEE');
      expect(await compter('rent_payments', 'lease_id = :l', { l: lease.id })).toBe(1);
    });
  });

  describe('GET /paiements (liste)', () => {
    async function troisPaiements() {
      const p = await nouveauProprietaire();
      const a = await bailActif(p);
      const b = await bailActif(p);
      await payerEspeces(p, a.lease.id, 10000, { paidOn: '2026-09-02' });
      await especes(p, { lease_id: a.lease.id, amount: 30000, paid_on: '2026-09-10', method: 'virement' });
      await payerEspeces(p, b.lease.id, 20000, { paidOn: '2026-09-20' });
      return { p, a, b };
    }

    test('liste vide : items [], total 0, totalPages 1', async () => {
      const p = await nouveauProprietaire();
      const res = await api().get('/api/v1/paiements').set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
    });

    test('pagination : pages 1, 2, au-delà ; total et totalPages exacts ; limit plafonnée à 100', async () => {
      const { p } = await troisPaiements();
      const p1 = await api().get('/api/v1/paiements?limit=2&page=1').set(p.h);
      expect(p1.body.data.items).toHaveLength(2);
      expect(p1.body.data.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
      const p2 = await api().get('/api/v1/paiements?limit=2&page=2').set(p.h);
      expect(p2.body.data.items).toHaveLength(1);
      const ids = new Set([...p1.body.data.items, ...p2.body.data.items].map((i) => i.id));
      expect(ids.size).toBe(3);
      const au_dela = await api().get('/api/v1/paiements?limit=2&page=9').set(p.h);
      expect(au_dela.body.data.items).toEqual([]);
      expect(au_dela.body.data.pagination.total).toBe(3);
      const plafond = await api().get('/api/v1/paiements?limit=1000').set(p.h);
      expect(plafond.status).toBe(200);
      expect(plafond.body.data.pagination.limit).toBe(100);
    });

    test.each([
      ['page=0'], ['page=-1'], ['page=abc'], ['limit=0'], ['limit=-5'], ['limit=abc'], ['tri=montant'], ['tri=amount;DROP TABLE users'],
      ['status=inconnu'], ['method=<script>'], ['lease_id=pas-un-uuid'], ['du=2026-02-30x'], ['au=hier'],
    ])('paramètre invalide %s → 422', async (qs) => {
      const p = await nouveauProprietaire();
      const res = await api().get(`/api/v1/paiements?${qs}`).set(p.h);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('DONNEES_INVALIDES');
    });

    test('filtres : bail, locataire, appartement, immeuble, mode, statut, période ; tri par montant', async () => {
      const { p, a, b } = await troisPaiements();
      const q = async (qs) => (await api().get(`/api/v1/paiements?${qs}`).set(p.h)).body.data.items.map((i) => i.amount);
      expect((await q(`lease_id=${a.lease.id}&tri=amount`))).toEqual([10000, 30000]);
      expect(await q(`tenant_id=${b.tenant.id}`)).toEqual([20000]);
      expect(await q(`apartment_id=${b.apartment.id}`)).toEqual([20000]);
      expect(await q(`building_id=${a.building.id}&tri=-amount`)).toEqual([30000, 10000]);
      expect(await q('method=virement')).toEqual([30000]);
      expect(await q('du=2026-09-05&au=2026-09-15')).toEqual([30000]);
      expect(await q('tri=amount')).toEqual([10000, 20000, 30000]);
      expect(await q('tri=-amount')).toEqual([30000, 20000, 10000]);
      // Défaut : date de paiement décroissante.
      expect(await q('')).toEqual([20000, 30000, 10000]);
      const [premier] = (await api().get('/api/v1/paiements?method=virement').set(p.h)).body.data.items;
      await api().post(`/api/v1/paiements/${premier.id}/rembourser`).set(p.h).send({ reason: 'Erreur de saisie' });
      expect(await q('status=rembourse')).toEqual([30000]);
      expect(await q('status=valide&tri=amount')).toEqual([10000, 20000]);
      const item = (await api().get(`/api/v1/paiements?lease_id=${a.lease.id}&tri=amount`).set(p.h)).body.data.items[0];
      expect(item).toMatchObject({ tenant: { id: a.tenant.id }, apartment: { id: a.apartment.id, building: { id: a.building.id } } });
    });

    test('isolation : un propriétaire ne voit jamais les paiements d’un autre, même en filtrant sur son bail', async () => {
      const { p, a } = await troisPaiements();
      const autre = await nouveauProprietaire();
      expect((await api().get('/api/v1/paiements').set(autre.h)).body.data.pagination.total).toBe(0);
      expect((await api().get(`/api/v1/paiements?lease_id=${a.lease.id}`).set(autre.h)).body.data.items).toEqual([]);
      expect((await api().get('/api/v1/paiements').set(p.h)).body.data.pagination.total).toBe(3);
    });
  });

  describe('GET /paiements/:id et /paiements/:id/quittances', () => {
    test('détail : imputations, échéance, locataire, appartement, transaction liée', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await api().post(`/api/v1/webhooks/paydunya/${providerId}`).type('form').send(enFormulaire(ipn(init.body.data.transaction.reference, 350000)));
      const { id } = await ligne('SELECT id FROM rent_payments WHERE transaction_id = :t', { t: init.body.data.transaction.id });
      const res = await api().get(`/api/v1/paiements/${id}`).set(p.h);
      expect(res.status).toBe(200);
      const d = res.body.data.payment;
      expect(d).toMatchObject({ id, amount: 350000, method: 'wave', status: 'valide' });
      expect(d.allocations).toEqual([expect.objectContaining({ amount: 350000, reversed_at: null, schedule: expect.objectContaining({ id: echeances[0].id, status: 'paye' }) })]);
      expect(d.transaction).toMatchObject({ id: init.body.data.transaction.id, provider: 'paydunya', wallet: 'wave', status: 'confirmee' });
      expect(d.transaction).not.toHaveProperty('raw_payload');
      expect(d.tenant).toHaveProperty('first_name');

      const q = await api().get(`/api/v1/paiements/${id}/quittances`).set(p.h);
      expect(q.status).toBe(200);
      expect(q.body.data.receipts).toEqual([expect.objectContaining({ rent_schedule_id: echeances[0].id, amount: 350000 })]);
    });

    test('introuvable → 404 ; identifiant invalide → 422 ; autre propriétaire → 403', async () => {
      const a = await nouveauProprietaire();
      const b = await nouveauProprietaire();
      const { lease } = await bailActif(a);
      const { payment } = await payerEspeces(a, lease.id, 1000);
      for (const suffixe of ['', '/quittances']) {
        expect((await api().get(`/api/v1/paiements/${UUID_ABSENT}${suffixe}`).set(a.h)).status).toBe(404);
        expect((await api().get(`/api/v1/paiements/pas-un-uuid${suffixe}`).set(a.h)).status).toBe(422);
        const autre = await api().get(`/api/v1/paiements/${payment.id}${suffixe}`).set(b.h);
        expect(autre.status).toBe(403);
        expect(autre.body.error.code).toBe('ACCES_AUTRE_PROPRIETAIRE');
      }
    });

    test('quittances d’un paiement partiel : aucune ; après remboursement : aucune (quittance annulée)', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      const partiel = await payerEspeces(p, lease.id, 100000, { scheduleId: sept.id });
      expect((await api().get(`/api/v1/paiements/${partiel.payment.id}/quittances`).set(p.h)).body.data.receipts).toEqual([]);
      const solde = await payerEspeces(p, lease.id, 250000, { scheduleId: sept.id });
      expect((await api().get(`/api/v1/paiements/${partiel.payment.id}/quittances`).set(p.h)).body.data.receipts).toHaveLength(1);
      await api().post(`/api/v1/paiements/${solde.payment.id}/rembourser`).set(p.h).send({ reason: 'Chèque impayé' });
      expect((await api().get(`/api/v1/paiements/${partiel.payment.id}/quittances`).set(p.h)).body.data.receipts).toEqual([]);
    });
  });

  describe('POST /paiements/:id/rembourser', () => {
    test('nominal : paiement « remboursé », échéances rouvertes, quittances annulées, sortie de caisse, journal, notification', async () => {
      const p = await nouveauProprietaire();
      const { lease, tenant } = await bailActif(p);
      const loc = await activerLocataire(p, tenant);
      const [sept, oct] = await echeancesDu(p, lease.id);
      const { payment } = await payerEspeces(p, lease.id, 500000, { scheduleId: sept.id });
      const res = await api().post(`/api/v1/paiements/${payment.id}/rembourser`).set(p.h).send({ reason: 'Trop-perçu', method: 'virement' });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Paiement remboursé');
      expect(res.body.data.payment).toMatchObject({ id: payment.id, status: 'rembourse', refund_reason: 'Trop-perçu', refunded_by: p.user.id });
      expect(res.body.data.payment.refunded_at).not.toBeNull();
      expect(await lignes('SELECT amount_paid, status FROM rent_schedules WHERE id IN (:ids) ORDER BY due_date', { ids: [sept.id, oct.id] }))
        .toEqual([{ amount_paid: 0, status: 'en_retard' }, { amount_paid: 0, status: expect.any(String) }]);
      expect(await compter('payment_allocations', 'rent_payment_id = :id AND reversed_at IS NULL', { id: payment.id })).toBe(0);
      expect(await compter('receipts', 'rent_schedule_id = :id AND cancelled_at IS NULL', { id: sept.id })).toBe(0);
      expect(await lignes("SELECT amount, method FROM cash_movements WHERE direction = 'sortie' AND source_id = :id", { id: payment.id })).toEqual([{ amount: 500000, method: 'virement' }]);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 500000, sorties: 500000 });
      expect(await compter('audit_logs', "action = 'paiement.remboursement' AND entity_id = :id", { id: payment.id })).toBe(1);
      expect(await compter('notifications', "user_id = :u AND title = 'Paiement remboursé'", { u: loc.user.id })).toBe(1);
    });

    test('paiement mobile money remboursé : la transaction passe « remboursée » (§ 51.4)', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await api().post(`/api/v1/webhooks/paydunya/${providerId}`).type('form').send(enFormulaire(ipn(init.body.data.transaction.reference, 350000)));
      const { id } = await ligne('SELECT id FROM rent_payments WHERE transaction_id = :t', { t: init.body.data.transaction.id });
      expect((await api().post(`/api/v1/paiements/${id}/rembourser`).set(p.h).send({ reason: 'Annulation du bail' })).status).toBe(200);
      const tx = await ligne('SELECT status, refunded_at FROM payment_transactions WHERE id = :id', { id: init.body.data.transaction.id });
      expect(tx.status).toBe('remboursee');
      expect(tx.refunded_at).not.toBeNull();
    });

    test.each([
      ['motif absent', {}],
      ['motif trop court', { reason: 'ab' }],
      ['motif trop long', { reason: 'x'.repeat(501) }],
      ['motif non texte', { reason: 12345 }],
      ['mode inconnu', { reason: 'Erreur', method: 'troc' }],
    ])('validation — %s → 422, paiement intact', async (_l, corps) => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const { payment } = await payerEspeces(p, lease.id, 1000);
      const res = await api().post(`/api/v1/paiements/${payment.id}/rembourser`).set(p.h).send(corps);
      expect(res.status).toBe(422);
      expect((await ligne('SELECT status FROM rent_payments WHERE id = :id', { id: payment.id })).status).toBe('valide');
    });

    test('introuvable → 404 ; autre propriétaire → 403 ; déjà remboursé → 409 DEJA_REMBOURSE', async () => {
      const a = await nouveauProprietaire();
      const b = await nouveauProprietaire();
      const { lease } = await bailActif(a);
      const { payment } = await payerEspeces(a, lease.id, 1000);
      expect((await api().post(`/api/v1/paiements/${UUID_ABSENT}/rembourser`).set(a.h).send({ reason: 'Erreur' })).status).toBe(404);
      expect((await api().post(`/api/v1/paiements/${payment.id}/rembourser`).set(b.h).send({ reason: 'Erreur' })).status).toBe(403);
      expect((await api().post(`/api/v1/paiements/${payment.id}/rembourser`).set(a.h).send({ reason: 'Erreur' })).status).toBe(200);
      const encore = await api().post(`/api/v1/paiements/${payment.id}/rembourser`).set(a.h).send({ reason: 'Erreur' });
      expect(encore.status).toBe(409);
      expect(encore.body.error.code).toBe('DEJA_REMBOURSE');
    });

    test('concurrence : remboursements simultanés du même paiement → un seul remboursement, une seule sortie de caisse', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const { payment } = await payerEspeces(p, lease.id, 350000);
      const reponses = await Promise.all(Array.from({ length: 4 }, () => api().post(`/api/v1/paiements/${payment.id}/rembourser`).set(p.h).send({ reason: 'Erreur de saisie' })));
      expect(reponses.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      expect(await compter('cash_movements', "direction = 'sortie' AND source_id = :id", { id: payment.id })).toBe(1);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 350000, sorties: 350000 });
      expect(await compter('audit_logs', "action = 'paiement.remboursement' AND entity_id = :id", { id: payment.id })).toBe(1);
    });

    test('rembourser puis ré-encaisser : l’échéance repasse PAYÉE avec une NOUVELLE quittance', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      const premier = await payerEspeces(p, lease.id, 350000, { scheduleId: sept.id });
      await api().post(`/api/v1/paiements/${premier.payment.id}/rembourser`).set(p.h).send({ reason: 'Chèque rejeté' });
      const second = await payerEspeces(p, lease.id, 350000, { scheduleId: sept.id });
      expect(second.receipts).toHaveLength(1);
      expect(second.receipts[0].number).not.toBe(premier.receipts[0].number);
      expect(await compter('receipts', 'rent_schedule_id = :id', { id: sept.id })).toBe(2);
      expect(await compter('receipts', 'rent_schedule_id = :id AND cancelled_at IS NULL', { id: sept.id })).toBe(1);
    });
  });

  describe('GET / PUT /paiements/moyens (§ 51.5)', () => {
    test('configuration PayDunya : identifiants chiffrés au repos, jamais renvoyés ; URL de webhook absolue', async () => {
      const p = await nouveauProprietaire();
      const res = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: PAYDUNYA, label: 'Mon PayDunya' });
      expect(res.status).toBe(200);
      const moyen = res.body.data.provider;
      expect(moyen).toMatchObject({ provider: 'paydunya', mode: 'integre', label: 'Mon PayDunya', is_active: true, credentials_configured: true });
      expect(moyen).not.toHaveProperty('credentials');
      expect(moyen.webhook_url).toBe(`${process.env.API_PUBLIC_URL}/api/v1/webhooks/paydunya/${moyen.id}`);
      const brut = await ligne('SELECT credentials FROM payment_providers WHERE id = :id', { id: moyen.id });
      for (const secret of [PAYDUNYA.master_key, PAYDUNYA.private_key, PAYDUNYA.token]) expect(brut.credentials).not.toContain(secret);
      const audit = await ligne("SELECT details FROM audit_logs WHERE action = 'paiement.configuration_moyen' AND entity_id = :id", { id: moyen.id });
      expect(audit.details).toMatchObject({ provider: 'paydunya', mode: 'integre', identifiants_modifies: true });
      expect(JSON.stringify(audit.details)).not.toContain(PAYDUNYA.private_key);
      expect(JSON.stringify(audit.details)).not.toContain(PAYDUNYA.master_key);

      const liste = await api().get('/api/v1/paiements/moyens').set(p.h);
      expect(liste.status).toBe(200);
      expect(liste.body.data.providers).toHaveLength(1);
      for (const secret of [PAYDUNYA.master_key, PAYDUNYA.private_key, PAYDUNYA.token]) expect(JSON.stringify(liste.body)).not.toContain(secret);
    });

    test('compte PayDunya de production : clés « live_ » acceptées en mode « live »', async () => {
      const p = await nouveauProprietaire();
      const production = { master_key: 'cle-principale-production', private_key: 'live_private_cle_production_01', token: 'jeton-production-01', mode: 'live' };
      const res = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: production });
      expect(res.status).toBe(200);
      expect(res.body.data.provider).toMatchObject({ provider: 'paydunya', credentials_configured: true });
    });

    test('moyen PayDunya dont les clés stockées sont incomplètes (ancien moyen converti) : réactivation refusée (422 IDENTIFIANTS_REQUIS) tant que les clés ne sont pas saisies', async () => {
      const p = await nouveauProprietaire();
      const cree = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: PAYDUNYA });
      const { PaymentProvider } = require('../../../../models/index.js');
      // État laissé par la migration : clés d'un autre fournisseur, moyen désactivé.
      const moyen = await PaymentProvider.findByPk(cree.body.data.provider.id);
      await moyen.update({ credentials: { api_key: 'ancienne_cle_api', api_secret: 'ancien_secret_api' }, is_active: false });

      for (const corps of [{ is_active: true }, {}, { label: 'Réactivé' }]) {
        const refus = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', ...corps });
        expect(refus.status).toBe(422);
        expect(refus.body.error.code).toBe('IDENTIFIANTS_REQUIS');
      }
      expect((await ligne('SELECT is_active FROM payment_providers WHERE id = :id', { id: moyen.id })).is_active).toBe(false);
      // Rester désactivé reste possible (libellé, etc.).
      expect((await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', is_active: false, label: 'En attente' })).status).toBe(200);

      const ok = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: PAYDUNYA });
      expect(ok.status).toBe(200);
      expect(ok.body.data.provider).toMatchObject({ id: moyen.id, is_active: true, credentials_configured: true });
    });

    test('mise à jour du même moyen (pas de doublon), désactivation, numéro de réception normalisé ; webhook_url nulle en mode preuve', async () => {
      const p = await nouveauProprietaire();
      const a = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'orange_money', mode: 'preuve', account_number: '78 111 22 33' });
      expect(a.body.data.provider).toMatchObject({ account_number: '+221781112233', webhook_url: null });
      const b = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'orange_money', mode: 'preuve', is_active: false, label: 'OM' });
      expect(b.body.data.provider).toMatchObject({ id: a.body.data.provider.id, is_active: false, label: 'OM', account_number: '+221781112233' });
      expect(await compter('payment_providers', 'owner_id = :o', { o: p.ownerId })).toBe(1);
      expect((await api().get('/api/v1/paiements/moyens').set(p.h)).body.data.providers).toHaveLength(1);
    });

    test.each([
      ['corps vide', {}],
      ['fournisseur inconnu', { provider: 'paypal', mode: 'integre' }],
      ['mode inconnu', { provider: 'wave', mode: 'automatique' }],
      ['numéro invalide', { provider: 'wave', mode: 'preuve', account_number: 'abc' }],
      ['clé principale PayDunya trop courte', { provider: 'paydunya', mode: 'integre', credentials: { ...PAYDUNYA, master_key: 'court' } }],
      ['clé principale PayDunya absente', { provider: 'paydunya', mode: 'integre', credentials: { ...PAYDUNYA, master_key: undefined } }],
      ['clé privée PayDunya absente', { provider: 'paydunya', mode: 'integre', credentials: { ...PAYDUNYA, private_key: undefined } }],
      ['jeton PayDunya absent', { provider: 'paydunya', mode: 'integre', credentials: { ...PAYDUNYA, token: undefined } }],
      ['clé privée de TEST en mode production', { provider: 'paydunya', mode: 'integre', credentials: { ...PAYDUNYA, mode: 'live' } }],
      ['clé privée de PRODUCTION en mode test', { provider: 'paydunya', mode: 'integre', credentials: { ...PAYDUNYA, private_key: 'live_private_cle_production_01', mode: 'test' } }],
      ['clé privée de PRODUCTION sans mode (test par défaut)', { provider: 'paydunya', mode: 'integre', credentials: { ...PAYDUNYA, private_key: 'live_private_cle_production_01', mode: undefined } }],
      ['mode PayDunya inconnu', { provider: 'paydunya', mode: 'integre', credentials: { ...PAYDUNYA, mode: 'staging' } }],
      ['identifiants au format Wave pour PayDunya', { provider: 'paydunya', mode: 'integre', credentials: { api_key: 'cle_api_test_123', webhook_secret: 'secret_webhook_123' } }],
      ['secret Wave absent', { provider: 'wave', mode: 'integre', credentials: { api_key: 'wave_api_key_test' } }],
      ['libellé trop long', { provider: 'wave', mode: 'preuve', account_number: '771112233', label: 'x'.repeat(101) }],
      ['Orange Money intégré en direct', { provider: 'orange_money', mode: 'integre', credentials: { api_key: 'cle_orange_test', webhook_secret: 'secret_orange_test' } }],
      ['PayDunya en mode preuve', { provider: 'paydunya', mode: 'preuve', account_number: '771112233' }],
      ['intégré sans identifiants', { provider: 'wave', mode: 'integre' }],
      ['preuve sans numéro', { provider: 'wave', mode: 'preuve' }],
    ])('validation — %s → 422, rien n’est créé', async (_l, corps) => {
      const p = await nouveauProprietaire();
      const res = await api().put('/api/v1/paiements/moyens').set(p.h).send(corps);
      expect(res.status).toBe(422);
      expect(await compter('payment_providers', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('isolation : les moyens d’un propriétaire ne sont jamais listés chez un autre', async () => {
      const a = await nouveauProprietaire();
      const b = await nouveauProprietaire();
      await api().put('/api/v1/paiements/moyens').set(a.h).send({ provider: 'wave', mode: 'preuve', account_number: '771112233' });
      expect((await api().get('/api/v1/paiements/moyens').set(b.h)).body.data.providers).toEqual([]);
    });
  });
});
