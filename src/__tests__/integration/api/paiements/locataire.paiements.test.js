'use strict';

const { decrypt } = require('../../../../utils/cryptoField.js');
const crypto = require('crypto');
const {
  api, bearer, nouveauProprietaire, bailActif, activerLocataire, proprietaireEtLocataire, fermer, sequelize, compter,
  pngTest, payerEspeces, expirerAbonnement,
} = require('../../../setup/helpers.js');
const {
  UUID_ABSENT, WAVE, PAYDUNYA, simulerFournisseurs, preparerPaydunya, preparerPreuve, deposerPreuve, initier, ipn, enFormulaire, factureDe, idTransaction,
  jetonExpire, ligne, verifierAuthentification, verifierCompteDesactive,
} = require('./outils.paiements.js');

/**
 * Espace locataire — Mes paiements (§ 12, § 28, § 44, § 51.2) :
 *   GET /locataire/paiements/moyens · GET /locataire/paiements
 *   GET /locataire/paiements/transactions · GET /locataire/paiements/transactions/:id
 *   POST /locataire/paiements (mode A intégré) · POST /locataire/paiements/preuves (mode B)
 */

const preuve = (loc, corps) => api().post('/api/v1/locataire/paiements/preuves').set(loc.h).send(corps);

describe('Paiements — espace locataire', () => {
  let fournisseurs;
  beforeAll(() => { fournisseurs = simulerFournisseurs(); });
  afterEach(() => fournisseurs.mode('ok'));
  afterAll(async () => {
    fournisseurs.restaurer();
    await fermer();
  });

  describe('authentification et autorisations', () => {
    const routes = [
      ['GET', `/api/v1/locataire/paiements/moyens?lease_id=${UUID_ABSENT}`, null],
      ['GET', '/api/v1/locataire/paiements', null],
      ['GET', '/api/v1/locataire/paiements/transactions', null],
      ['GET', `/api/v1/locataire/paiements/transactions/${UUID_ABSENT}`, null],
      ['POST', '/api/v1/locataire/paiements', { rent_schedule_id: UUID_ABSENT, wallet: 'wave' }],
      ['POST', '/api/v1/locataire/paiements/preuves', { rent_schedule_id: UUID_ABSENT, wallet: 'wave', provider_transaction_id: 'WV-1234', amount: 1000 }],
    ];

    test.each(routes)('%s %s : 401 sans jeton valide (absent, falsifié, expiré, refresh, révoqué)', async (methode, url, corps) => {
      const { locataire } = await proprietaireEtLocataire();
      await verifierAuthentification(methode, url, locataire, corps);
    });

    test('compte locataire désactivé → 403 sur chaque route', async () => {
      const { locataire } = await proprietaireEtLocataire();
      await verifierCompteDesactive(routes, locataire);
    });

    test('un propriétaire n’accède pas à l’espace locataire (403 ESPACE_LOCATAIRE_REQUIS)', async () => {
      const p = await nouveauProprietaire();
      for (const [methode, url, corps] of routes) {
        const r = api()[methode.toLowerCase()](url).set(p.h).set('Idempotency-Key', crypto.randomUUID());
        const res = methode === 'GET' ? await r : await r.send(corps);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ESPACE_LOCATAIRE_REQUIS');
      }
    });
  });

  describe('GET /locataire/paiements/moyens', () => {
    test('moyens proposés : bénéficiaire, portefeuilles intégrés via PayDunya, preuve, espèces', async () => {
      const { p, loc, lease } = await preparerPaydunya();
      await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'orange_money', mode: 'preuve', account_number: '781234567', label: 'OM perso' });
      const res = await api().get(`/api/v1/locataire/paiements/moyens?lease_id=${lease.id}`).set(loc.h);
      expect(res.status).toBe(200);
      expect(res.body.data.methods).toEqual({
        beneficiaire: expect.any(String),
        integre: expect.arrayContaining(['wave', 'orange_money']),
        preuve: [{ wallet: 'orange_money', label: 'OM perso', account_number: '+221781234567' }],
        especes: true,
      });
      expect(JSON.stringify(res.body)).not.toContain('secret');
    });

    test('moyen désactivé non proposé ; abonnement du bailleur échu → aucun paiement intégré', async () => {
      const { p, loc, lease } = await preparerPaydunya();
      await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'preuve', account_number: '771112233', is_active: false });
      let m = (await api().get(`/api/v1/locataire/paiements/moyens?lease_id=${lease.id}`).set(loc.h)).body.data.methods;
      expect(m.preuve).toEqual([]);
      await expirerAbonnement(p.ownerId);
      m = (await api().get(`/api/v1/locataire/paiements/moyens?lease_id=${lease.id}`).set(loc.h)).body.data.methods;
      expect(m.integre).toEqual([]);
    });

    test('bail manquant ou invalide → 422 ; bail d’un autre locataire → 403 ; inconnu → 404', async () => {
      const { proprio: p, locataire } = await proprietaireEtLocataire();
      const autre = await bailActif(p);
      expect((await api().get('/api/v1/locataire/paiements/moyens').set(locataire.h)).status).toBe(422);
      expect((await api().get('/api/v1/locataire/paiements/moyens?lease_id=abc').set(locataire.h)).status).toBe(422);
      const res = await api().get(`/api/v1/locataire/paiements/moyens?lease_id=${autre.lease.id}`).set(locataire.h);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCES_AUTRE_LOCATAIRE');
      expect((await api().get(`/api/v1/locataire/paiements/moyens?lease_id=${UUID_ABSENT}`).set(locataire.h)).status).toBe(404);
    });
  });

  describe('GET /locataire/paiements et /transactions', () => {
    test('le locataire ne voit que SES paiements, sans champs internes ; pagination exacte', async () => {
      const { proprio: p, locataire, lease } = await proprietaireEtLocataire();
      const autre = await bailActif(p);
      for (const m of [1000, 2000, 3000]) await payerEspeces(p, lease.id, m, { paidOn: `2026-09-0${m / 1000}` });
      await payerEspeces(p, autre.lease.id, 9999);
      const res = await api().get('/api/v1/locataire/paiements?limit=2').set(locataire.h);
      expect(res.status).toBe(200);
      expect(res.body.data.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(res.body.data.items.map((i) => i.amount)).toEqual([3000, 2000]);
      expect(Object.keys(res.body.data.items[0]).sort()).toEqual(['amount', 'id', 'method', 'paid_on', 'reference', 'refunded_at', 'status']);
      const p2 = await api().get('/api/v1/locataire/paiements?limit=2&page=2').set(locataire.h);
      expect(p2.body.data.items.map((i) => i.amount)).toEqual([1000]);
      expect((await api().get('/api/v1/locataire/paiements?page=5').set(locataire.h)).body.data.items).toEqual([]);
      expect((await api().get('/api/v1/locataire/paiements?limit=1000').set(locataire.h)).body.data.pagination.limit).toBe(100);
    });

    test.each(['page=0', 'page=-1', 'limit=0', 'limit=abc'])('pagination invalide %s → 422 (paiements et transactions)', async (qs) => {
      const { locataire } = await proprietaireEtLocataire();
      expect((await api().get(`/api/v1/locataire/paiements?${qs}`).set(locataire.h)).status).toBe(422);
      expect((await api().get(`/api/v1/locataire/paiements/transactions?${qs}`).set(locataire.h)).status).toBe(422);
    });

    test('transactions : liste et détail des siennes (statut interrogé au retour de la page de paiement), jamais celles d’un autre', async () => {
      const { p, loc, echeances } = await preparerPaydunya();
      const autreBail = await bailActif(p);
      const autreLoc = await activerLocataire(p, autreBail.tenant);
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const liste = await api().get('/api/v1/locataire/paiements/transactions').set(loc.h);
      expect(liste.body.data.items).toHaveLength(1);
      expect(liste.body.data.items[0]).toMatchObject({ id: init.body.data.transaction.id, status: 'en_attente', checkout_url: `https://app.paydunya.com/sandbox-checkout/invoice/${factureDe(init.body.data.transaction.reference).token}` });
      expect(liste.body.data.items[0]).not.toHaveProperty('raw_payload');
      expect(liste.body.data.items[0]).not.toHaveProperty('provider_token');
      const detail = await api().get(`/api/v1/locataire/paiements/transactions/${init.body.data.transaction.id}`).set(loc.h);
      expect(detail.status).toBe(200);
      expect(detail.body.data.transaction).toMatchObject({ status: 'en_attente', payment: null });
      expect(detail.body.data.transaction).not.toHaveProperty('owner_id');
      expect((await api().get('/api/v1/locataire/paiements/transactions').set(autreLoc.h)).body.data.items).toEqual([]);
      const refus = await api().get(`/api/v1/locataire/paiements/transactions/${init.body.data.transaction.id}`).set(autreLoc.h);
      expect(refus.status).toBe(403);
      expect((await api().get(`/api/v1/locataire/paiements/transactions/${UUID_ABSENT}`).set(loc.h)).status).toBe(404);
      expect((await api().get('/api/v1/locataire/paiements/transactions/abc').set(loc.h)).status).toBe(422);
    });
  });

  describe('POST /locataire/paiements (mode A intégré)', () => {
    test('nominal : demande « en attente », URL de paiement, facture PayDunya complète ; RIEN n’est payé (§ 12)', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const res = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'orange_money' });
      expect(res.status).toBe(201);
      const reference = res.body.data.transaction.reference;
      const facture = factureDe(reference);
      expect(res.body.data).toMatchObject({
        transaction: { amount: 350000, wallet: 'orange_money', status: 'en_attente' },
        checkout_url: `https://app.paydunya.com/sandbox-checkout/invoice/${facture.token}`,
        reused: false,
      });
      expect(reference).toMatch(/^TRX-[0-9A-Z]+-[0-9A-F]{8}$/);
      const appel = fournisseurs.appels[fournisseurs.appels.length - 1];
      // Compte de TEST : API bac à sable.
      expect(appel.url).toBe('https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create');
      const { display_name: bailleur } = await ligne('SELECT display_name FROM owners WHERE id = :o', { o: p.ownerId });
      expect(appel.corps).toMatchObject({
        // Page de paiement restreinte au portefeuille choisi.
        invoice: { total_amount: 350000, channels: ['orange-money-senegal'] },
        custom_data: { reference },
        actions: { callback_url: `${process.env.API_PUBLIC_URL}/api/v1/webhooks/paydunya/${providerId}` },
        // Nom affiché sur la page de paiement : le bailleur, bénéficiaire des fonds.
        store: { name: bailleur },
      });
      expect(appel.corps.invoice.description).toContain(reference);
      expect(appel.corps.actions.return_url).toContain(encodeURIComponent(reference));
      expect(appel.corps.actions.cancel_url).toContain(encodeURIComponent(reference));
      expect(appel.entetes).toMatchObject({
        'PAYDUNYA-MASTER-KEY': PAYDUNYA.master_key, 'PAYDUNYA-PRIVATE-KEY': PAYDUNYA.private_key, 'PAYDUNYA-TOKEN': PAYDUNYA.token,
      });
      // Le jeton de facture est conservé (IPN sans référence), jamais exposé au locataire.
      expect((await ligne('SELECT provider, provider_token FROM payment_transactions WHERE id = :id', { id: res.body.data.transaction.id }))).toEqual({ provider: 'paydunya', provider_token: facture.token });
      const e = await ligne('SELECT amount_paid, status FROM rent_schedules WHERE id = :id', { id: echeances[0].id });
      expect(e.amount_paid).toBe(0);
      expect(e.status).not.toBe('paye');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect(await compter('audit_logs', "action = 'paiement.initiation' AND entity_id = :id", { id: res.body.data.transaction.id })).toBe(1);
    });

    test('Wave direct configuré : priorité à Wave Checkout (clé d’idempotence = référence)', async () => {
      const p = await nouveauProprietaire();
      const { lease, tenant } = await bailActif(p);
      await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'integre', credentials: WAVE });
      const loc = await activerLocataire(p, tenant);
      const [sept] = (await api().get(`/api/v1/echeances?lease_id=${lease.id}&tri=due_date`).set(p.h)).body.data.items;
      const res = await initier(loc, { rent_schedule_id: sept.id, wallet: 'wave' });
      expect(res.status).toBe(201);
      expect(res.body.data.checkout_url).toBe('https://pay.wave.com/c/cos_abc');
      const appel = fournisseurs.appels[fournisseurs.appels.length - 1];
      expect(appel.url).toMatch(/\/v1\/checkout\/sessions$/);
      expect(appel.entetes['Idempotency-Key']).toBe(res.body.data.transaction.reference);
      expect(appel.corps).toMatchObject({ amount: '350000', currency: 'XOF', client_reference: res.body.data.transaction.reference });
      // Orange Money n'est pas proposé par Wave direct.
      const om = await initier(loc, { rent_schedule_id: sept.id, wallet: 'orange_money' });
      expect(om.status).toBe(409);
      expect(om.body.error.code).toBe('PAIEMENT_INTEGRE_INDISPONIBLE');
    });

    test('montant partiel accepté ; supérieur au reste dû → 422 MONTANT_SUPERIEUR_AU_DU', async () => {
      const { loc, echeances } = await preparerPaydunya();
      expect((await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave', amount: 100000 })).body.data.transaction.amount).toBe(100000);
      const trop = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave', amount: 350001 });
      expect(trop.status).toBe(422);
      expect(trop.body.error.code).toBe('MONTANT_SUPERIEUR_AU_DU');
    });

    test.each([
      ['corps vide', {}],
      ['portefeuille manquant', { rent_schedule_id: UUID_ABSENT }],
      ['portefeuille inconnu', { rent_schedule_id: UUID_ABSENT, wallet: 'free_money' }],
      ['ni échéance ni charge', { wallet: 'wave' }],
      ['échéance ET charge', { rent_schedule_id: UUID_ABSENT, charge_id: UUID_ABSENT, wallet: 'wave' }],
      ['montant négatif', { rent_schedule_id: UUID_ABSENT, wallet: 'wave', amount: -1 }],
      ['montant nul', { rent_schedule_id: UUID_ABSENT, wallet: 'wave', amount: 0 }],
      ['montant texte', { rent_schedule_id: UUID_ABSENT, wallet: 'wave', amount: 'tout' }],
      ['échéance non UUID', { rent_schedule_id: "'; DROP TABLE rent_schedules; --", wallet: 'wave' }],
    ])('validation — %s → 422, aucune demande créée', async (_l, corps) => {
      const { loc, p } = await preparerPaydunya();
      const res = await initier(loc, corps);
      expect(res.status).toBe(422);
      expect(await compter('payment_transactions', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('en-tête Idempotency-Key obligatoire → 422 IDEMPOTENCE_REQUISE', async () => {
      const { loc, echeances } = await preparerPaydunya();
      const res = await api().post('/api/v1/locataire/paiements').set(loc.h).send({ rent_schedule_id: echeances[0].id, wallet: 'wave' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('IDEMPOTENCE_REQUISE');
    });

    test('§ 44 paiement déjà effectué → 409 DEJA_PAYE ; échéance annulée → 409 ; échéance d’un autre → 403 ; inconnue → 404', async () => {
      const { p, loc, echeances, lease } = await preparerPaydunya();
      await payerEspeces(p, lease.id, 350000, { scheduleId: echeances[0].id });
      const deja = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      expect(deja.status).toBe(409);
      expect(deja.body.error.code).toBe('DEJA_PAYE');
      await api().post(`/api/v1/echeances/${echeances[1].id}/annuler`).set(p.h).send({ reason: 'Remise' });
      const annulee = await initier(loc, { rent_schedule_id: echeances[1].id, wallet: 'wave' });
      expect(annulee.status).toBe(409);
      expect(annulee.body.error.code).toBe('ECHEANCE_ANNULEE');
      const autre = await bailActif(p);
      const [eAutre] = (await api().get(`/api/v1/echeances?lease_id=${autre.lease.id}`).set(p.h)).body.data.items;
      expect((await initier(loc, { rent_schedule_id: eAutre.id, wallet: 'wave' })).status).toBe(403);
      expect((await initier(loc, { rent_schedule_id: UUID_ABSENT, wallet: 'wave' })).status).toBe(404);
    });

    test('bailleur sans paiement intégré configuré → 409 PAIEMENT_INTEGRE_INDISPONIBLE', async () => {
      const { locataire, lease, proprio } = await proprietaireEtLocataire();
      const [sept] = (await api().get(`/api/v1/echeances?lease_id=${lease.id}`).set(proprio.h)).body.data.items;
      const res = await initier(locataire, { rent_schedule_id: sept.id, wallet: 'wave' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAIEMENT_INTEGRE_INDISPONIBLE');
    });

    test('§ 44 paiement échoué : refus du fournisseur → 409, transaction « échouée » ; panne → 503, puis nouvel essai avec la MÊME clé accepté', async () => {
      const { loc, echeances } = await preparerPaydunya();
      fournisseurs.mode('refus');
      const refus = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('PAIEMENT_REFUSE_FOURNISSEUR');
      expect((await ligne('SELECT status, rejection_reason FROM payment_transactions WHERE rent_schedule_id = :id', { id: echeances[0].id }))).toEqual({ status: 'echouee', rejection_reason: 'Invalid Masterkey Specified' });

      fournisseurs.mode('panne');
      const cle = crypto.randomUUID();
      const panne = await initier(loc, { rent_schedule_id: echeances[1].id, wallet: 'wave' }, cle);
      expect(panne.status).toBe(503);
      expect(panne.body.error.code).toBe('FOURNISSEUR_INDISPONIBLE');
      fournisseurs.mode('ok');
      const reprise = await initier(loc, { rent_schedule_id: echeances[1].id, wallet: 'wave' }, cle);
      expect(reprise.status).toBe(201);
      expect(reprise.headers['idempotent-replayed']).toBeUndefined();
      const statuts = await sequelize.query('SELECT status FROM payment_transactions WHERE rent_schedule_id = :id ORDER BY created_at', { replacements: { id: echeances[1].id }, type: sequelize.QueryTypes.SELECT });
      expect(statuts.map((s) => s.status)).toEqual(['echouee', 'en_attente']);
    });

    test('§ 44 réseau coupé / retour dans l’application : même clé → réponse rejouée ; autre clé → demande en cours réutilisée (200)', async () => {
      const { loc, echeances, p } = await preparerPaydunya();
      const cle = crypto.randomUUID();
      const a = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' }, cle);
      const rejeu = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' }, cle);
      expect(rejeu.status).toBe(201);
      expect(rejeu.headers['idempotent-replayed']).toBe('true');
      expect(rejeu.body.data.transaction.id).toBe(a.body.data.transaction.id);
      const retour = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      expect(retour.status).toBe(200);
      expect(retour.body.data.reused).toBe(true);
      expect(retour.body.data.transaction.id).toBe(a.body.data.transaction.id);
      expect(await compter('payment_transactions', 'owner_id = :o', { o: p.ownerId })).toBe(1);
      // Montant différent : nouvelle demande.
      expect((await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave', amount: 1000 })).status).toBe(201);
    });

    test('§ 44 double clic simultané avec la même clé : une seule demande', async () => {
      const { loc, echeances, p } = await preparerPaydunya();
      const cle = crypto.randomUUID();
      const reponses = await Promise.all([1, 2, 3].map(() => initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' }, cle)));
      expect(reponses.some((r) => r.status === 201)).toBe(true);
      for (const r of reponses) expect([201, 409]).toContain(r.status);
      expect(await compter('payment_transactions', 'owner_id = :o', { o: p.ownerId })).toBe(1);
    });

    test('§ 44 session expirée : 401, aucune demande créée', async () => {
      const { loc, echeances, p } = await preparerPaydunya();
      const res = await api().post('/api/v1/locataire/paiements').set(bearer(await jetonExpire(loc.user))).set('Idempotency-Key', crypto.randomUUID())
        .send({ rent_schedule_id: echeances[0].id, wallet: 'wave' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_EXPIRE');
      expect(await compter('payment_transactions', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('§ 44 parcours complet : initiation → IPN (facture relue) → PAYÉ → quittance → notification propriétaire', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await api().post(`/api/v1/webhooks/paydunya/${providerId}`).type('form').send(enFormulaire(ipn(init.body.data.transaction.reference, 350000)));
      const statut = await api().get(`/api/v1/locataire/paiements/transactions/${init.body.data.transaction.id}`).set(loc.h);
      expect(statut.body.data.transaction).toMatchObject({ status: 'confirmee', payment: expect.objectContaining({ amount: 350000 }) });
      expect((await api().get('/api/v1/locataire/quittances').set(loc.h)).body.data.items).toHaveLength(1);
      expect(await compter('notifications', "user_id = :u AND title = 'Nouveau paiement'", { u: p.user.id })).toBe(1);
      expect(await compter('notifications', "user_id = :u AND title = 'Paiement confirmé'", { u: loc.user.id })).toBe(1);
    });
  });

  describe('POST /locataire/paiements/preuves (mode B)', () => {
    test('nominal avec capture : « en attente de validation », capture visible du locataire, propriétaire notifié', async () => {
      const { p, loc, echeances } = await preparerPreuve();
      const res = await api().post('/api/v1/locataire/paiements/preuves').set(loc.h)
        .field('rent_schedule_id', echeances[0].id).field('wallet', 'wave').field('provider_transaction_id', 'WV.2026/09-ABC_1')
        .field('amount', '350000').field('payer_phone', '77 123 45 67')
        .attach('fichier', await pngTest(), { filename: 'capture.png', contentType: 'image/png' });
      expect(res.status).toBe(201);
      expect(res.body.data.transaction).toMatchObject({ amount: 350000, wallet: 'wave', status: 'en_attente' });
      const tx = await ligne('SELECT mode, provider_transaction_id, payer_phone, proof_document_id FROM payment_transactions WHERE id = :id', { id: res.body.data.transaction.id });
      expect(tx).toMatchObject({ mode: 'preuve', provider_transaction_id: 'WV.2026/09-ABC_1' });
      // Numéro du payeur CHIFFRÉ au repos (constat M13), exact une fois déchiffré.
      expect(tx.payer_phone).toMatch(/^v1:/);
      expect(decrypt(tx.payer_phone)).toBe('+221771234567');
      expect((await api().get(`/api/v1/documents/${tx.proof_document_id}/fichier`).set(loc.h)).status).toBe(200);
      expect(await compter('notifications', "user_id = :u AND title = 'Preuve de paiement à valider'", { u: p.user.id })).toBe(1);
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('fichier d’un type refusé → 4xx, rien n’est créé', async () => {
      const { loc, echeances, p } = await preparerPreuve();
      const res = await api().post('/api/v1/locataire/paiements/preuves').set(loc.h)
        .field('rent_schedule_id', echeances[0].id).field('wallet', 'wave').field('provider_transaction_id', idTransaction()).field('amount', '1000')
        .attach('fichier', Buffer.from('#!/bin/sh\necho pirate'), { filename: 'capture.png', contentType: 'image/png' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await compter('payment_transactions', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test.each([
      ['identifiant manquant', { wallet: 'wave', amount: 1000 }],
      ['identifiant trop court', { wallet: 'wave', amount: 1000, provider_transaction_id: 'ABC' }],
      ['identifiant trop long', { wallet: 'wave', amount: 1000, provider_transaction_id: 'A'.repeat(101) }],
      ['identifiant à caractères spéciaux', { wallet: 'wave', amount: 1000, provider_transaction_id: 'WV 12<script>' }],
      ['montant manquant', { wallet: 'wave', provider_transaction_id: 'WV-12345' }],
      ['montant négatif', { wallet: 'wave', amount: -10, provider_transaction_id: 'WV-12345' }],
      ['portefeuille inconnu', { wallet: 'paypal', amount: 1000, provider_transaction_id: 'WV-12345' }],
      ['téléphone invalide', { wallet: 'wave', amount: 1000, provider_transaction_id: 'WV-12345', payer_phone: 'abc' }],
    ])('validation — %s → 422', async (_l, corps) => {
      const { loc, echeances, p } = await preparerPreuve();
      expect((await preuve(loc, { rent_schedule_id: echeances[0].id, ...corps })).status).toBe(422);
      expect(await compter('payment_transactions', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('portefeuille non proposé → 409 MODE_NON_DISPONIBLE ; échéance payée → 409 DEJA_PAYE ; échéance d’un autre → 403', async () => {
      const { p, loc, echeances, lease } = await preparerPreuve();
      const om = await preuve(loc, { rent_schedule_id: echeances[0].id, wallet: 'orange_money', provider_transaction_id: idTransaction('OM'), amount: 1000 });
      expect(om.status).toBe(409);
      expect(om.body.error.code).toBe('MODE_NON_DISPONIBLE');
      await payerEspeces(p, lease.id, 350000, { scheduleId: echeances[0].id });
      const deja = await preuve(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave', provider_transaction_id: idTransaction(), amount: 1000 });
      expect(deja.status).toBe(409);
      expect(deja.body.error.code).toBe('DEJA_PAYE');
      const autre = await bailActif(p);
      const [eAutre] = (await api().get(`/api/v1/echeances?lease_id=${autre.lease.id}`).set(p.h)).body.data.items;
      expect((await preuve(loc, { rent_schedule_id: eAutre.id, wallet: 'wave', provider_transaction_id: idTransaction(), amount: 1000 })).status).toBe(403);
    });

    test('§ 56.1 un même identifiant de transaction ne compte qu’une fois — y compris en soumissions simultanées', async () => {
      const { loc, echeances, p } = await preparerPreuve();
      const corps = { rent_schedule_id: echeances[0].id, wallet: 'wave', provider_transaction_id: idTransaction(), amount: 350000 };
      const reponses = await Promise.all([1, 2, 3].map(() => preuve(loc, corps)));
      expect(reponses.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(reponses.find((r) => r.status === 409).body.error.code).toBe('PREUVE_DEJA_SOUMISE');
      expect(await compter('payment_transactions', 'owner_id = :o', { o: p.ownerId })).toBe(1);
      expect(await compter('notifications', "user_id = :u AND title = 'Preuve de paiement à valider'", { u: p.user.id })).toBe(1);
    });

    test('preuve supérieure au reste dû : acceptée (l’excédent sera soumis au propriétaire à la validation)', async () => {
      const { loc, echeances } = await preparerPreuve();
      const tx = await deposerPreuve(loc, echeances[0].id, 500000);
      expect(tx.status).toBe('en_attente');
      expect(tx.amount).toBe(500000);
    });
  });
});
