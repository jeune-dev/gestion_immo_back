'use strict';

const crypto = require('crypto');
const {
  api, nouveauProprietaire, bailActif, fermer, sequelize, compter, pngTest,
  desactiverEdlObligatoire, creerImmeuble, creerAppartement, creerLocataire,
} = require('../../../setup/helpers.js');
const {
  UUID_ABSENT, simulerFournisseurs, preparerPaydunya, preparerPreuve, deposerPreuve, initier, ipn, enFormulaire, idTransaction,
  soldeCaisse, ligne, lignes, verifierAuthentification, verifierCompteDesactive, restreindrePermissions,
} = require('./outils.paiements.js');

/**
 * Transactions numériques et file « À rapprocher » (§ 51.2 mode B, § 51.3, § 51.4, § 56.2) :
 *   GET /paiements/transactions · GET /paiements/transactions/:id
 *   POST /paiements/transactions/:id/valider · POST /paiements/transactions/:id/rejeter
 *   GET /paiements/rapprochements · POST /paiements/rapprochements/:id/resoudre
 *   POST /paiements/rapprochements/:id/rejeter
 */

const webhook = (providerId, corps) => api().post(`/api/v1/webhooks/paydunya/${providerId}`).type('form').send(enFormulaire(corps));
const valider = (p, id, entetes = {}) => api().post(`/api/v1/paiements/transactions/${id}/valider`).set(p.h).set(entetes).send({});
const rejeterPreuve = (p, id, corps) => api().post(`/api/v1/paiements/transactions/${id}/rejeter`).set(p.h).send(corps);

/** Paiement non identifié dans la file du propriétaire (référence inconnue). */
async function nonIdentifie(providerId, montant, telephone = '221700000001') {
  const res = await webhook(providerId, ipn(`INCONNUE-${crypto.randomBytes(4).toString('hex')}`, montant, 'completed', { telephone }));
  if (!res.body.data?.reconciliation_entry_id) throw new Error(`Rapprochement : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.reconciliation_entry_id;
}

describe('Transactions et rapprochements — espace propriétaire', () => {
  let fournisseurs;
  beforeAll(() => { fournisseurs = simulerFournisseurs(); });
  afterAll(async () => {
    fournisseurs.restaurer();
    await fermer();
  });

  describe('authentification et autorisations', () => {
    const routes = [
      ['GET', '/api/v1/paiements/transactions', null],
      ['GET', `/api/v1/paiements/transactions/${UUID_ABSENT}`, null],
      ['POST', `/api/v1/paiements/transactions/${UUID_ABSENT}/valider`, {}],
      ['POST', `/api/v1/paiements/transactions/${UUID_ABSENT}/rejeter`, { reason: 'Introuvable' }],
      ['GET', '/api/v1/paiements/rapprochements', null],
      ['POST', `/api/v1/paiements/rapprochements/${UUID_ABSENT}/resoudre`, {}],
      ['POST', `/api/v1/paiements/rapprochements/${UUID_ABSENT}/rejeter`, { note: 'Pas à moi' }],
    ];

    test.each(routes)('%s %s : 401 sans jeton valide', async (methode, url, corps) => {
      await verifierAuthentification(methode, url, await nouveauProprietaire(), corps);
    });

    test('compte désactivé → 403 sur chaque route', async () => {
      await verifierCompteDesactive(routes, await nouveauProprietaire());
    });

    test('un locataire n’accède à aucune de ces routes (403)', async () => {
      const { loc } = await preparerPreuve();
      for (const [methode, url, corps] of routes) {
        const r = api()[methode.toLowerCase()](url).set(loc.h);
        const res = methode === 'GET' ? await r : await r.send(corps);
        expect(res.status).toBe(403);
      }
    });

    test('permission « paiements.valider » requise pour valider, refuser, résoudre et rejeter', async () => {
      const { p, loc, echeances } = await preparerPreuve();
      const tx = await deposerPreuve(loc, echeances[0].id, 350000);
      await restreindrePermissions(p, ['paiements.lire']);
      expect((await api().get('/api/v1/paiements/transactions').set(p.h)).status).toBe(200);
      expect((await api().get('/api/v1/paiements/rapprochements').set(p.h)).status).toBe(200);
      for (const res of [
        await valider(p, tx.id),
        await rejeterPreuve(p, tx.id, { reason: 'Introuvable' }),
        await api().post(`/api/v1/paiements/rapprochements/${UUID_ABSENT}/resoudre`).set(p.h).send({}),
        await api().post(`/api/v1/paiements/rapprochements/${UUID_ABSENT}/rejeter`).set(p.h).send({ note: 'Pas à moi' }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('PERMISSION_REFUSEE');
      }
      expect((await ligne('SELECT status FROM payment_transactions WHERE id = :id', { id: tx.id })).status).toBe('en_attente');
    });
  });

  describe('GET /paiements/transactions', () => {
    test('liste : champs sensibles exclus, locataire et échéance joints ; filtres, tri, pagination', async () => {
      const { p, loc, echeances, tenant, lease } = await preparerPreuve();
      const a = await deposerPreuve(loc, echeances[0].id, 100000);
      const b = await deposerPreuve(loc, echeances[1].id, 350000);
      await rejeterPreuve(p, a.id, { reason: 'Introuvable sur mon relevé' });

      const res = await api().get('/api/v1/paiements/transactions').set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
      const [premier] = res.body.data.items;
      expect(premier).not.toHaveProperty('raw_payload');
      expect(premier).not.toHaveProperty('provider_token');
      expect(premier.tenant).toMatchObject({ id: tenant.id });
      expect(premier.schedule).toHaveProperty('amount_due');

      const ids = async (qs) => (await api().get(`/api/v1/paiements/transactions?${qs}`).set(p.h)).body.data.items.map((i) => i.id);
      expect(await ids('status=echouee')).toEqual([a.id]);
      expect(await ids('status=en_attente')).toEqual([b.id]);
      expect(await ids('mode=preuve&tri=amount')).toEqual([a.id, b.id]);
      expect(await ids('mode=integre')).toEqual([]);
      expect(await ids('provider=wave&tri=-amount')).toEqual([b.id, a.id]);
      expect(await ids(`tenant_id=${tenant.id}&lease_id=${lease.id}&tri=amount`)).toEqual([a.id, b.id]);
      expect(await ids(`lease_id=${UUID_ABSENT}`)).toEqual([]);
      const page2 = await api().get('/api/v1/paiements/transactions?limit=1&page=2&tri=amount').set(p.h);
      expect(page2.body.data.items.map((i) => i.id)).toEqual([b.id]);
      expect(page2.body.data.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
      expect((await api().get('/api/v1/paiements/transactions?limit=500').set(p.h)).body.data.pagination.limit).toBe(100);
      // Isolation.
      const autre = await nouveauProprietaire();
      expect((await api().get('/api/v1/paiements/transactions').set(autre.h)).body.data.items).toEqual([]);
    });

    test.each(['status=payee', 'mode=cash', 'provider=stripe', 'tri=status', 'tenant_id=1', 'page=0', 'limit=0', 'limit=xyz'])('paramètre invalide %s → 422', async (qs) => {
      const p = await nouveauProprietaire();
      expect((await api().get(`/api/v1/paiements/transactions?${qs}`).set(p.h)).status).toBe(422);
    });
  });

  describe('GET /paiements/transactions/:id', () => {
    test('détail avec la preuve déposée (capture) et le paiement lié après validation', async () => {
      const { p, loc, echeances } = await preparerPreuve();
      const depot = await api().post('/api/v1/locataire/paiements/preuves').set(loc.h)
        .field('rent_schedule_id', echeances[0].id).field('wallet', 'wave').field('provider_transaction_id', idTransaction()).field('amount', '350000')
        .attach('fichier', await pngTest(), { filename: 'capture.png', contentType: 'image/png' });
      expect(depot.status).toBe(201);
      const id = depot.body.data.transaction.id;
      const avant = await api().get(`/api/v1/paiements/transactions/${id}`).set(p.h);
      expect(avant.status).toBe(200);
      expect(avant.body.data.transaction).toMatchObject({ id, mode: 'preuve', status: 'en_attente', payment: null });
      expect(avant.body.data.transaction.proof).toMatchObject({ category: 'preuve_paiement', mime_type: 'image/png', visible_to_tenant: true });
      expect(avant.body.data.transaction.proof.url).toMatch(/^\/api\/v1\/documents\/[0-9a-f-]{36}\/fichier$/);
      expect(avant.body.data.transaction).not.toHaveProperty('raw_payload');
      await valider(p, id);
      const apres = await api().get(`/api/v1/paiements/transactions/${id}`).set(p.h);
      expect(apres.body.data.transaction.payment).toMatchObject({ amount: 350000, status: 'valide' });
    });

    test('introuvable → 404 ; invalide → 422 ; autre propriétaire → 403', async () => {
      const { loc, echeances } = await preparerPreuve();
      const tx = await deposerPreuve(loc, echeances[0].id, 1000);
      const autre = await nouveauProprietaire();
      expect((await api().get(`/api/v1/paiements/transactions/${UUID_ABSENT}`).set(autre.h)).status).toBe(404);
      expect((await api().get('/api/v1/paiements/transactions/123').set(autre.h)).status).toBe(422);
      expect((await api().get(`/api/v1/paiements/transactions/${tx.id}`).set(autre.h)).status).toBe(403);
    });
  });

  describe('POST /paiements/transactions/:id/valider (§ 51.2 mode B)', () => {
    test('validation en un clic : paiement enregistré, échéance PAYÉE, quittance, notifications, journal', async () => {
      const { p, loc, echeances } = await preparerPreuve();
      const tx = await deposerPreuve(loc, echeances[0].id, 350000);
      // § 12 : rien n'est payé avant la validation.
      expect((await ligne('SELECT amount_paid FROM rent_schedules WHERE id = :id', { id: echeances[0].id })).amount_paid).toBe(0);
      expect(await compter('notifications', "user_id = :u AND title = 'Preuve de paiement à valider'", { u: p.user.id })).toBe(1);
      const res = await valider(p, tx.id);
      expect(res.status).toBe(200);
      expect(res.body.data.transaction).toMatchObject({ id: tx.id, status: 'confirmee', validated_by: p.user.id });
      expect(res.body.data.payment).toMatchObject({ amount: 350000, method: 'wave', transaction_id: tx.id, status: 'valide' });
      expect(res.body.data.receipts).toHaveLength(1);
      expect((await ligne('SELECT status FROM rent_schedules WHERE id = :id', { id: echeances[0].id })).status).toBe('paye');
      expect(await compter('audit_logs', "action = 'paiement.validation_preuve' AND entity_id = :id", { id: tx.id })).toBe(1);
      expect(await compter('notifications', "user_id = :u AND title = 'Paiement confirmé'", { u: loc.user.id })).toBe(1);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 350000, sorties: 0 });
    });

    test('§ 51.3 preuve SUPÉRIEURE au dû : échéance payée, excédent en attente de décision (pas imputé d’office)', async () => {
      const { p, loc, echeances } = await preparerPreuve();
      const tx = await deposerPreuve(loc, echeances[0].id, 400000);
      await valider(p, tx.id);
      expect((await ligne('SELECT amount_paid FROM rent_schedules WHERE id = :id', { id: echeances[1].id })).amount_paid).toBe(0);
      const entree = await ligne("SELECT type, status, amount FROM reconciliation_entries WHERE transaction_id = :t", { t: tx.id });
      expect(entree).toEqual({ type: 'excedent', status: 'en_attente', amount: 50000 });
    });

    test('déjà validée → 409 DEJA_TRAITEE ; refusée puis validée → 409 ; transaction intégrée → 409 MODE_INVALIDE', async () => {
      const { p, loc, echeances } = await preparerPreuve();
      const a = await deposerPreuve(loc, echeances[0].id, 1000);
      expect((await valider(p, a.id)).status).toBe(200);
      const encore = await valider(p, a.id);
      expect(encore.status).toBe(409);
      expect(encore.body.error.code).toBe('DEJA_TRAITEE');
      const b = await deposerPreuve(loc, echeances[1].id, 1000);
      await rejeterPreuve(p, b.id, { reason: 'Montant inexact' });
      expect((await valider(p, b.id)).status).toBe(409);

      const paydunya = await preparerPaydunya();
      const init = await initier(paydunya.loc, { rent_schedule_id: paydunya.echeances[0].id, wallet: 'wave' });
      const integre = await valider(paydunya.p, init.body.data.transaction.id);
      expect(integre.status).toBe(409);
      expect(integre.body.error.code).toBe('MODE_INVALIDE');
      expect(await compter('rent_payments', 'owner_id = :o', { o: paydunya.p.ownerId })).toBe(0);
    });

    test('introuvable → 404 ; autre propriétaire → 403 (rien n’est payé)', async () => {
      const { loc, echeances } = await preparerPreuve();
      const tx = await deposerPreuve(loc, echeances[0].id, 1000);
      const autre = await nouveauProprietaire();
      expect((await valider(autre, UUID_ABSENT)).status).toBe(404);
      expect((await valider(autre, tx.id)).status).toBe(403);
      expect((await ligne('SELECT status FROM payment_transactions WHERE id = :id', { id: tx.id })).status).toBe('en_attente');
    });

    test('concurrence : validations simultanées de la même preuve → un seul paiement', async () => {
      const { p, loc, echeances } = await preparerPreuve();
      const tx = await deposerPreuve(loc, echeances[0].id, 350000);
      const reponses = await Promise.all(Array.from({ length: 4 }, () => valider(p, tx.id)));
      expect(reponses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(reponses.filter((r) => r.status === 409)).toHaveLength(3);
      expect(await compter('rent_payments', 'transaction_id = :t', { t: tx.id })).toBe(1);
      expect((await ligne('SELECT amount_paid FROM rent_schedules WHERE id = :id', { id: echeances[0].id })).amount_paid).toBe(350000);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 350000, sorties: 0 });
    });

    test('§ 44 double clic avec la même clé d’idempotence : réponse rejouée, un seul paiement', async () => {
      const { p, loc, echeances } = await preparerPreuve();
      const tx = await deposerPreuve(loc, echeances[0].id, 350000);
      const cle = crypto.randomUUID();
      const a = await valider(p, tx.id, { 'Idempotency-Key': cle });
      const b = await valider(p, tx.id, { 'Idempotency-Key': cle });
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.data.payment.id).toBe(a.body.data.payment.id);
      expect(await compter('rent_payments', 'transaction_id = :t', { t: tx.id })).toBe(1);
    });
  });

  describe('POST /paiements/transactions/:id/rejeter (§ 56.2 preuve refusée)', () => {
    test('refus : transaction échouée avec motif, locataire notifié, journal ; échéance inchangée', async () => {
      const { p, loc, echeances } = await preparerPreuve();
      const tx = await deposerPreuve(loc, echeances[0].id, 350000);
      const res = await rejeterPreuve(p, tx.id, { reason: 'Transaction introuvable sur mon relevé' });
      expect(res.status).toBe(200);
      expect(res.body.data.transaction).toMatchObject({ status: 'echouee', rejection_reason: 'Transaction introuvable sur mon relevé', validated_by: p.user.id });
      expect(res.body.data.transaction.failed_at).not.toBeNull();
      expect(await compter('notifications', "user_id = :u AND title = 'Preuve de paiement refusée'", { u: loc.user.id })).toBe(1);
      expect(await compter('audit_logs', "action = 'paiement.rejet_preuve' AND entity_id = :id", { id: tx.id })).toBe(1);
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      const encore = await rejeterPreuve(p, tx.id, { reason: 'Encore' });
      expect(encore.status).toBe(409);
      expect(encore.body.error.code).toBe('DEJA_TRAITEE');
    });

    test.each([['motif absent', {}], ['motif trop court', { reason: 'no' }], ['motif trop long', { reason: 'x'.repeat(501) }]])('validation — %s → 422', async (_l, corps) => {
      const { p, loc, echeances } = await preparerPreuve();
      const tx = await deposerPreuve(loc, echeances[0].id, 1000);
      expect((await rejeterPreuve(p, tx.id, corps)).status).toBe(422);
      expect((await ligne('SELECT status FROM payment_transactions WHERE id = :id', { id: tx.id })).status).toBe('en_attente');
    });

    test('transaction intégrée → 409 MODE_INVALIDE ; autre propriétaire → 403 ; introuvable → 404', async () => {
      const { p, loc, echeances } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const res = await rejeterPreuve(p, init.body.data.transaction.id, { reason: 'Refus' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MODE_INVALIDE');
      const autre = await nouveauProprietaire();
      expect((await rejeterPreuve(autre, init.body.data.transaction.id, { reason: 'Refus' })).status).toBe(403);
      expect((await rejeterPreuve(autre, UUID_ABSENT, { reason: 'Refus' })).status).toBe(404);
    });
  });

  describe('GET /paiements/rapprochements', () => {
    test('file par défaut « à traiter » ; filtres type et statut ; pagination exacte ; isolation', async () => {
      const { p, providerId, loc, echeances } = await preparerPaydunya();
      const e1 = await nonIdentifie(providerId, 1000);
      const e2 = await nonIdentifie(providerId, 2000);
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await webhook(providerId, ipn(init.body.data.transaction.reference, 360000));
      await api().post(`/api/v1/paiements/rapprochements/${e1}/rejeter`).set(p.h).send({ note: 'Pas un locataire' });

      const res = await api().get('/api/v1/paiements/rapprochements').set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.pagination.total).toBe(2);
      const excedent = res.body.data.items.find((i) => i.type === 'excedent');
      expect(excedent).toMatchObject({ amount: 10000, status: 'en_attente', payment: expect.objectContaining({ amount: 360000 }), tenant: expect.any(Object) });
      const ids = async (qs) => (await api().get(`/api/v1/paiements/rapprochements?${qs}`).set(p.h)).body.data.items.map((i) => i.id);
      expect(await ids('type=non_identifie')).toEqual([e2]);
      expect(await ids('status=rejete')).toEqual([e1]);
      expect(await ids('status=resolu')).toEqual([]);
      const p1 = await api().get('/api/v1/paiements/rapprochements?limit=1').set(p.h);
      expect(p1.body.data.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
      expect((await api().get('/api/v1/paiements/rapprochements').set((await nouveauProprietaire()).h)).body.data.items).toEqual([]);
    });

    test.each(['type=autre', 'status=ouvert', 'page=-1', 'limit=0'])('paramètre invalide %s → 422', async (qs) => {
      const p = await nouveauProprietaire();
      expect((await api().get(`/api/v1/paiements/rapprochements?${qs}`).set(p.h)).status).toBe(422);
    });
  });

  describe('POST /paiements/rapprochements/:id/resoudre', () => {
    test('non identifié → bail désigné : paiement enregistré (FIFO), caisse, journal, entrée résolue', async () => {
      const { p, providerId, lease, echeances } = await preparerPaydunya();
      const id = await nonIdentifie(providerId, 400000);
      const res = await api().post(`/api/v1/paiements/rapprochements/${id}/resoudre`).set(p.h).send({ lease_id: lease.id, note: 'Virement de M. Ndiaye' });
      expect(res.status).toBe(200);
      expect(res.body.data.entree).toMatchObject({ id, status: 'resolu', lease_id: lease.id, resolved_by: p.user.id, resolution_note: 'Virement de M. Ndiaye' });
      expect(res.body.data.quittances).toHaveLength(1);
      expect(await lignes('SELECT amount_paid FROM rent_schedules WHERE id IN (:ids) ORDER BY due_date', { ids: [echeances[0].id, echeances[1].id] })).toEqual([{ amount_paid: 350000 }, { amount_paid: 50000 }]);
      const paiement = await ligne('SELECT method, comment FROM rent_payments WHERE lease_id = :l', { l: lease.id });
      // PayDunya n'indique pas le portefeuille utilisé : jamais deviné.
      expect(paiement.method).toBe('autre');
      expect(paiement.comment).toMatch(/^Rapprochement manuel — paydunya:test_[0-9a-f]{10}$/);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 400000, sorties: 0 });
      expect(await compter('audit_logs', "action = 'rapprochement.resolution' AND entity_id = :id", { id })).toBe(1);
    });

    test('non identifié ciblé sur une échéance précise', async () => {
      const { p, providerId, lease, echeances } = await preparerPaydunya();
      const id = await nonIdentifie(providerId, 350000);
      await api().post(`/api/v1/paiements/rapprochements/${id}/resoudre`).set(p.h).send({ lease_id: lease.id, rent_schedule_id: echeances[2].id });
      expect((await ligne('SELECT status FROM rent_schedules WHERE id = :id', { id: echeances[2].id })).status).toBe('paye');
      expect((await ligne('SELECT amount_paid FROM rent_schedules WHERE id = :id', { id: echeances[0].id })).amount_paid).toBe(0);
    });

    test('non identifié : bail manquant → 422 ; bail d’un autre → 403 ; échéance d’un autre bail → 422 ; bail brouillon → 409 ; UUID invalide → 422', async () => {
      const { p, providerId, lease } = await preparerPaydunya();
      const id = await nonIdentifie(providerId, 1000);
      const url = `/api/v1/paiements/rapprochements/${id}/resoudre`;
      expect((await api().post(url).set(p.h).send({})).status).toBe(422);
      expect((await api().post(url).set(p.h).send({ lease_id: 'x' })).status).toBe(422);
      expect((await api().post(url).set(p.h).send({ lease_id: lease.id, note: 'n'.repeat(1001) })).status).toBe(422);
      const autre = await nouveauProprietaire();
      const bailAutre = await bailActif(autre);
      expect((await api().post(url).set(p.h).send({ lease_id: bailAutre.lease.id })).status).toBe(403);
      const second = await bailActif(p);
      const [e2] = (await api().get(`/api/v1/echeances?lease_id=${second.lease.id}`).set(p.h)).body.data.items;
      expect((await api().post(url).set(p.h).send({ lease_id: lease.id, rent_schedule_id: e2.id })).status).toBe(422);
      await desactiverEdlObligatoire(p);
      const imm = await creerImmeuble(p);
      const app = await creerAppartement(p, imm.id);
      const locataire = await creerLocataire(p);
      const brouillon = (await api().post('/api/v1/baux').set(p.h).send({ apartment_id: app.id, tenant_id: locataire.id, start_date: '2026-10-01', rent_amount: 1000, deposit_amount: 0, due_day: 5 })).body.data.lease;
      const refus = await api().post(url).set(p.h).send({ lease_id: brouillon.id });
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('BAIL_INVALIDE');
      expect((await ligne('SELECT status FROM reconciliation_entries WHERE id = :id', { id })).status).toBe('en_attente');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('non identifié supérieur à tout le dû du bail → 422 et entrée intacte (transaction annulée)', async () => {
      const { p, providerId } = await preparerPaydunya();
      const { lease } = await bailActif(p, { bail: { end_date: '2026-09-30' } });
      const id = await nonIdentifie(providerId, 999999);
      const res = await api().post(`/api/v1/paiements/rapprochements/${id}/resoudre`).set(p.h).send({ lease_id: lease.id });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('MONTANT_SUPERIEUR_AU_DU');
      expect((await ligne('SELECT status, rent_payment_id FROM reconciliation_entries WHERE id = :id', { id }))).toEqual({ status: 'en_attente', rent_payment_id: null });
      expect(await compter('rent_payments', 'lease_id = :l', { l: lease.id })).toBe(0);
      expect(await compter('cash_movements', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('excédent confirmé → imputé à l’échéance suivante ; sans échéance ouverte → 409 CREDIT_NON_IMPUTABLE, rien ne change', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya({ bail: { end_date: '2026-10-31' } });
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await webhook(providerId, ipn(init.body.data.transaction.reference, 1050000));
      const [excedent] = (await api().get('/api/v1/paiements/rapprochements?type=excedent').set(p.h)).body.data.items;
      expect(excedent.amount).toBe(700000);
      const refus = await api().post(`/api/v1/paiements/rapprochements/${excedent.id}/resoudre`).set(p.h).send({});
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('CREDIT_NON_IMPUTABLE');
      expect((await ligne('SELECT amount_paid FROM rent_schedules WHERE id = :id', { id: echeances[1].id })).amount_paid).toBe(0);
      expect((await ligne('SELECT status FROM reconciliation_entries WHERE id = :id', { id: excedent.id })).status).toBe('en_attente');
    });

    test('déjà traitée → 409 DEJA_TRAITEE ; introuvable → 404 ; autre propriétaire → 403', async () => {
      const { p, providerId, lease } = await preparerPaydunya();
      const id = await nonIdentifie(providerId, 1000);
      const autre = await nouveauProprietaire();
      expect((await api().post(`/api/v1/paiements/rapprochements/${id}/resoudre`).set(autre.h).send({ lease_id: lease.id })).status).toBe(403);
      expect((await api().post(`/api/v1/paiements/rapprochements/${UUID_ABSENT}/resoudre`).set(p.h).send({ lease_id: lease.id })).status).toBe(404);
      expect((await api().post(`/api/v1/paiements/rapprochements/${id}/resoudre`).set(p.h).send({ lease_id: lease.id })).status).toBe(200);
      const encore = await api().post(`/api/v1/paiements/rapprochements/${id}/resoudre`).set(p.h).send({ lease_id: lease.id });
      expect(encore.status).toBe(409);
      expect(encore.body.error.code).toBe('DEJA_TRAITEE');
    });

    test('concurrence : résolutions simultanées de la même entrée → un seul paiement', async () => {
      const { p, providerId, lease } = await preparerPaydunya();
      const id = await nonIdentifie(providerId, 100000);
      const reponses = await Promise.all(Array.from({ length: 3 }, () => api().post(`/api/v1/paiements/rapprochements/${id}/resoudre`).set(p.h).send({ lease_id: lease.id })));
      expect(reponses.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await compter('rent_payments', 'lease_id = :l', { l: lease.id })).toBe(1);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 100000, sorties: 0 });
    });
  });

  describe('POST /paiements/rapprochements/:id/rejeter', () => {
    test('non identifié rejeté : aucun mouvement de caisse (l’argent n’y était jamais entré)', async () => {
      const { p, providerId } = await preparerPaydunya();
      const id = await nonIdentifie(providerId, 5000);
      const res = await api().post(`/api/v1/paiements/rapprochements/${id}/rejeter`).set(p.h).send({ note: 'Erreur de destinataire' });
      expect(res.status).toBe(200);
      expect(res.body.data.entry).toMatchObject({ id, status: 'rejete', resolution_note: 'Erreur de destinataire', resolved_by: p.user.id });
      expect(await compter('cash_movements', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect(await compter('audit_logs', "action = 'rapprochement.rejet' AND entity_id = :id", { id })).toBe(1);
    });

    test('excédent rejeté : sortie de caisse « remboursement » du montant de l’excédent, locataire notifié', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await webhook(providerId, ipn(init.body.data.transaction.reference, 400000));
      const [excedent] = (await api().get('/api/v1/paiements/rapprochements?type=excedent').set(p.h)).body.data.items;
      const res = await api().post(`/api/v1/paiements/rapprochements/${excedent.id}/rejeter`).set(p.h).send({ note: 'Rendu', refund_method: 'wave' });
      expect(res.status).toBe(200);
      expect(await lignes("SELECT category, amount, method FROM cash_movements WHERE owner_id = :o AND direction = 'sortie'", { o: p.ownerId })).toEqual([{ category: 'remboursement', amount: 50000, method: 'wave' }]);
      expect(await compter('notifications', "user_id = :u AND title = 'Excédent remboursé'", { u: loc.user.id })).toBe(1);
    });

    test.each([['note absente', {}], ['note trop courte', { note: 'no' }], ['mode inconnu', { note: 'Rendu', refund_method: 'troc' }]])('validation — %s → 422', async (_l, corps) => {
      const { p, providerId } = await preparerPaydunya();
      const id = await nonIdentifie(providerId, 1000);
      expect((await api().post(`/api/v1/paiements/rapprochements/${id}/rejeter`).set(p.h).send(corps)).status).toBe(422);
    });

    test('déjà traitée → 409 ; introuvable → 404 ; autre propriétaire → 403 ; concurrence → un seul rejet', async () => {
      const { p, providerId } = await preparerPaydunya();
      const id = await nonIdentifie(providerId, 1000);
      expect((await api().post(`/api/v1/paiements/rapprochements/${UUID_ABSENT}/rejeter`).set(p.h).send({ note: 'Rendu' })).status).toBe(404);
      expect((await api().post(`/api/v1/paiements/rapprochements/${id}/rejeter`).set((await nouveauProprietaire()).h).send({ note: 'Rendu' })).status).toBe(403);
      const reponses = await Promise.all(Array.from({ length: 3 }, () => api().post(`/api/v1/paiements/rapprochements/${id}/rejeter`).set(p.h).send({ note: 'Rendu' })));
      expect(reponses.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await compter('audit_logs', "action = 'rapprochement.rejet' AND entity_id = :id", { id })).toBe(1);
    });

    test('excédent d’un paiement déjà remboursé → 409 DEJA_REMBOURSE, aucune sortie supplémentaire', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await webhook(providerId, ipn(init.body.data.transaction.reference, 400000));
      const { id: paiementId } = await ligne('SELECT id FROM rent_payments WHERE transaction_id = :t', { t: init.body.data.transaction.id });
      const [excedent] = (await api().get('/api/v1/paiements/rapprochements?type=excedent').set(p.h)).body.data.items;
      // Entrée remise « à traiter » artificiellement : le garde-fou du paiement joue seul.
      await api().post(`/api/v1/paiements/${paiementId}/rembourser`).set(p.h).send({ reason: 'Départ' });
      await sequelize.query("UPDATE reconciliation_entries SET status = 'en_attente' WHERE id = :id", { replacements: { id: excedent.id } });
      const res = await api().post(`/api/v1/paiements/rapprochements/${excedent.id}/rejeter`).set(p.h).send({ note: 'Rendu' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DEJA_REMBOURSE');
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 400000, sorties: 400000 });
    });
  });

  test('§ 51.3 rapprochement par montant + numéro payeur quand la référence manque', async () => {
    const { p, providerId, tenant, echeances } = await preparerPaydunya();
    const res = await webhook(providerId, ipn(`SANS-REF-${crypto.randomBytes(3).toString('hex')}`, 350000, 'completed', { telephone: tenant.phone.replace('+', '') }));
    expect(res.status).toBe(200);
    expect(res.body.data.rapproche_par).toBe('montant_telephone');
    expect((await ligne('SELECT method FROM rent_payments WHERE owner_id = :o', { o: p.ownerId })).method).toBe('autre');
    expect((await ligne('SELECT status FROM rent_schedules WHERE id = :id', { id: echeances[0].id })).status).toBe('paye');
    expect(await compter('reconciliation_entries', 'owner_id = :o', { o: p.ownerId })).toBe(0);
  });
});
