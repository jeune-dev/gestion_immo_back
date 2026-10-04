'use strict';

const crypto = require('crypto');
const {
  api, bearer, nouveauProprietaire, bailActif, activerLocataire, fermer, sequelize,
} = require('../../../setup/helpers.js');
const {
  PAYDUNYA, simulerFournisseurs, ipn, corpsIpn, enFormulaire, factureDe,
} = require('../../../setup/paydunyaSimule.js');

/**
 * Paiement des loyers (§ 12), quittances (§ 13), Wave / Orange Money et
 * rapprochement (§ 51), cas d'acceptation § 44 et § 56.2.
 */

/** IPN PayDunya au format réel (x-www-form-urlencoded) ; la facture est relue par le serveur. */
const notifier = (providerId, corps) => api().post(`/api/v1/webhooks/paydunya/${providerId}`).type('form').send(enFormulaire(corps));

async function echeancesDu(proprio, leaseId) {
  const res = await api().get(`/api/v1/echeances?lease_id=${leaseId}&tri=due_date&limit=100`).set(proprio.h);
  return res.body.data.items;
}

describe('Paiements', () => {
  let fournisseurs;
  beforeAll(() => {
    // Seuls les appels sortants vers PayDunya sont simulés : tout le reste
    // (base, imputation, quittance, relecture de la facture) est réel.
    fournisseurs = simulerFournisseurs();
  });
  afterAll(async () => {
    fournisseurs.restaurer();
    await fermer();
  });

  describe('encaissement en espèces (§ 12)', () => {
    test('montant exact : échéance PAYÉE, quittance PDF, entrée de caisse « loyer », journal d’audit', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      const res = await api().post('/api/v1/paiements/especes').set(p.h)
        .send({ lease_id: lease.id, rent_schedule_id: sept.id, amount: 350000, paid_on: '2026-09-23', comment: 'Remis en main propre' });
      expect(res.status).toBe(201);
      expect(res.body.data.payment.reference).toMatch(/^PAY-20260923-\d{3}$/);
      expect(res.body.data.receipts).toHaveLength(1);

      const e = (await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule;
      expect(e.status).toBe('paye');
      expect(e.receipt.number).toMatch(/^QUI-\d{4}-\d{5}$/);

      const pdf = await api().get(`/api/v1/quittances/${e.receipt.id}/pdf`).set(p.h);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');

      const [[caisse]] = await sequelize.query("SELECT category, amount, is_deposit FROM cash_movements WHERE source_id = :id", { replacements: { id: res.body.data.payment.id } });
      expect(caisse).toEqual({ category: 'loyer', amount: 350000, is_deposit: false });
      const [[audit]] = await sequelize.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'paiement.paiement' AND entity_id = :id", { replacements: { id: res.body.data.payment.id } });
      expect(audit.n).toBe(1);
    });

    test('paiement partiel puis complément : partiellement payé → payé, quittance aux deux références', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, rent_schedule_id: sept.id, amount: 200000, paid_on: '2026-09-10' });
      let e = (await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule;
      expect(e.amount_paid).toBe(200000);
      expect(['partiellement_paye', 'en_retard']).toContain(e.status);
      await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, rent_schedule_id: sept.id, amount: 150000, paid_on: '2026-09-12' });
      e = (await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule;
      expect(e.status).toBe('paye');
      const [[r]] = await sequelize.query('SELECT payment_references FROM receipts WHERE rent_schedule_id = :id', { replacements: { id: sept.id } });
      expect(r.payment_references).toHaveLength(2);
    });

    test('espèces supérieures au dû ciblé : imputées aux échéances suivantes ; au-delà de tout le dû → 422', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p, { bail: { end_date: '2026-11-30' } });
      const echeances = await echeancesDu(p, lease.id);
      expect(echeances).toHaveLength(3);
      const res = await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, rent_schedule_id: echeances[0].id, amount: 700000, paid_on: '2026-09-02' });
      expect(res.status).toBe(201);
      expect(res.body.data.receipts).toHaveLength(2);
      const trop = await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, amount: 400000, paid_on: '2026-09-03' });
      expect(trop.status).toBe(422);
      expect(trop.body.error.code).toBe('MONTANT_SUPERIEUR_AU_DU');
      // La transaction a été annulée : aucun paiement orphelin.
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM rent_payments WHERE lease_id = :id', { replacements: { id: lease.id } });
      expect(n).toBe(1);
    });

    test('§ 44 double clic : même Idempotency-Key → un seul paiement, réponse rejouée', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const corps = { lease_id: lease.id, amount: 100000, paid_on: '2026-09-05' };
      const cle = crypto.randomUUID();
      const [a, b] = await Promise.all([
        api().post('/api/v1/paiements/especes').set(p.h).set('Idempotency-Key', cle).send(corps),
        api().post('/api/v1/paiements/especes').set(p.h).set('Idempotency-Key', cle).send(corps),
      ]);
      expect([a.status, b.status].sort()).toEqual(expect.arrayContaining([201]));
      const rejoue = await api().post('/api/v1/paiements/especes').set(p.h).set('Idempotency-Key', cle).send(corps);
      expect(rejoue.status).toBe(201);
      expect(rejoue.headers['idempotent-replayed']).toBe('true');
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM rent_payments WHERE lease_id = :id', { replacements: { id: lease.id } });
      expect(n).toBe(1);
    });

    test('remboursement : échéance rouverte, quittance annulée, sortie de caisse', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      const pay = await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, rent_schedule_id: sept.id, amount: 350000, paid_on: '2026-09-05' });
      const rb = await api().post(`/api/v1/paiements/${pay.body.data.payment.id}/rembourser`).set(p.h).send({ reason: 'Erreur de saisie' });
      expect(rb.status).toBe(200);
      const e = (await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule;
      expect(e.amount_paid).toBe(0);
      expect(e.status).not.toBe('paye');
      const [[q]] = await sequelize.query('SELECT cancelled_at FROM receipts WHERE rent_schedule_id = :id', { replacements: { id: sept.id } });
      expect(q.cancelled_at).not.toBeNull();
      const [[s]] = await sequelize.query("SELECT amount FROM cash_movements WHERE category = 'remboursement' AND source_id = :id", { replacements: { id: pay.body.data.payment.id } });
      expect(s.amount).toBe(350000);
      expect((await api().post(`/api/v1/paiements/${pay.body.data.payment.id}/rembourser`).set(p.h).send({ reason: 'Encore' })).status).toBe(409);
    });

    test('un propriétaire ne peut ni encaisser sur le bail d’un autre, ni lire ses paiements (403)', async () => {
      const a = await nouveauProprietaire();
      const b = await nouveauProprietaire();
      const { lease } = await bailActif(a);
      const pay = await api().post('/api/v1/paiements/especes').set(a.h).send({ lease_id: lease.id, amount: 1000, paid_on: '2026-09-05' });
      expect((await api().post('/api/v1/paiements/especes').set(b.h).send({ lease_id: lease.id, amount: 1000, paid_on: '2026-09-05' })).status).toBe(403);
      expect((await api().get(`/api/v1/paiements/${pay.body.data.payment.id}`).set(b.h)).status).toBe(403);
    });
  });

  describe('paiement direct avec preuve (§ 51.2 mode B)', () => {
    test('dépôt de preuve → validation en un clic → PAYÉ ; identifiant réutilisé → 409', async () => {
      const p = await nouveauProprietaire();
      const { lease, tenant } = await bailActif(p);
      await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'preuve', account_number: '771112233', label: 'Wave perso' });
      const loc = await activerLocataire(p, tenant);
      const [sept] = await echeancesDu(p, lease.id);

      const moyens = await api().get(`/api/v1/locataire/paiements/moyens?lease_id=${lease.id}`).set(loc.h);
      expect(moyens.body.data.methods.preuve[0]).toMatchObject({ wallet: 'wave', account_number: '+221771112233' });

      const preuve = await api().post('/api/v1/locataire/paiements/preuves').set(loc.h)
        .send({ rent_schedule_id: sept.id, wallet: 'wave', provider_transaction_id: 'WV-123456', amount: 350000 });
      expect(preuve.status).toBe(201);
      expect(preuve.body.data.transaction.status).toBe('en_attente');
      // Rien n'est payé tant que le propriétaire n'a pas validé (§ 12).
      expect((await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule.amount_paid).toBe(0);

      const doublon = await api().post('/api/v1/locataire/paiements/preuves').set(loc.h)
        .send({ rent_schedule_id: sept.id, wallet: 'wave', provider_transaction_id: 'WV-123456', amount: 350000 });
      expect(doublon.status).toBe(409);

      const ok = await api().post(`/api/v1/paiements/transactions/${preuve.body.data.transaction.id}/valider`).set(p.h);
      expect(ok.status).toBe(200);
      expect((await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule.status).toBe('paye');
      const quittances = await api().get('/api/v1/locataire/quittances').set(loc.h);
      expect(quittances.body.data.items).toHaveLength(1);
      expect((await api().post(`/api/v1/paiements/transactions/${preuve.body.data.transaction.id}/valider`).set(p.h)).status).toBe(409);
    });

    test('§ 56.2 preuve refusée : transaction échouée, échéance inchangée', async () => {
      const p = await nouveauProprietaire();
      const { lease, tenant } = await bailActif(p);
      await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'orange_money', mode: 'preuve', account_number: '781112233' });
      const loc = await activerLocataire(p, tenant);
      const [sept] = await echeancesDu(p, lease.id);
      const preuve = await api().post('/api/v1/locataire/paiements/preuves').set(loc.h)
        .send({ rent_schedule_id: sept.id, wallet: 'orange_money', provider_transaction_id: 'OM-778899', amount: 350000 });
      const rejet = await api().post(`/api/v1/paiements/transactions/${preuve.body.data.transaction.id}/rejeter`).set(p.h).send({ reason: 'Transaction introuvable sur mon relevé' });
      expect(rejet.body.data.transaction.status).toBe('echouee');
      expect((await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule.amount_paid).toBe(0);
    });

    test('un locataire ne peut pas déclarer un paiement sur l’échéance d’un autre (403)', async () => {
      const p = await nouveauProprietaire();
      const a = await bailActif(p);
      const b = await bailActif(p);
      await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'preuve', account_number: '771112299' });
      const locB = await activerLocataire(p, b.tenant);
      const [septA] = await echeancesDu(p, a.lease.id);
      const res = await api().post('/api/v1/locataire/paiements/preuves').set(locB.h)
        .send({ rent_schedule_id: septA.id, wallet: 'wave', provider_transaction_id: 'WV-999', amount: 350000 });
      expect(res.status).toBe(403);
      expect((await api().get(`/api/v1/locataire/echeances/${septA.id}`).set(locB.h)).status).toBe(403);
    });
  });

  describe('paiement intégré Wave / Orange Money via PayDunya (§ 51.2 mode A, § 51.3)', () => {
    async function preparer() {
      const p = await nouveauProprietaire();
      const bail = await bailActif(p);
      const moyen = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: PAYDUNYA });
      expect(moyen.status).toBe(200);
      expect(moyen.body.data.provider).not.toHaveProperty('credentials');
      const loc = await activerLocataire(p, bail.tenant);
      const echeances = await echeancesDu(p, bail.lease.id);
      return { p, loc, ...bail, echeances, providerId: moyen.body.data.provider.id };
    }
    const initier = (loc, corps) => api().post('/api/v1/locataire/paiements').set(loc.h).set('Idempotency-Key', crypto.randomUUID()).send(corps);

    test('initiation : rien n’est payé avant la confirmation serveur ; double initiation = même demande', async () => {
      const { p, loc, echeances } = await preparer();
      const a = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      expect(a.status).toBe(201);
      expect(a.body.data.checkout_url).toBe(`https://app.paydunya.com/sandbox-checkout/invoice/${factureDe(a.body.data.transaction.reference).token}`);
      const b = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      expect(b.status).toBe(200);
      expect(b.body.data.transaction.id).toBe(a.body.data.transaction.id);
      expect((await api().get(`/api/v1/echeances/${echeances[0].id}`).set(p.h)).body.data.schedule.amount_paid).toBe(0);
      // Sans en-tête d'idempotence : refusé.
      expect((await api().post('/api/v1/locataire/paiements').set(loc.h).send({ rent_schedule_id: echeances[0].id, wallet: 'wave' })).status).toBe(422);
    });

    test('IPN signée : PAYÉ + quittance ; § 44 webhook reçu deux fois → traité une seule fois', async () => {
      const { p, loc, echeances, providerId } = await preparer();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const ref = init.body.data.transaction.reference;
      const r1 = await notifier(providerId, ipn(ref, 350000));
      expect(r1.status).toBe(200);
      const r2 = await notifier(providerId, ipn(ref, 350000));
      expect(r2.status).toBe(200);
      expect(r2.body.data.deja).toBe(true);
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM rent_payments WHERE transaction_id = :id', { replacements: { id: init.body.data.transaction.id } });
      expect(n).toBe(1);
      expect((await api().get(`/api/v1/echeances/${echeances[0].id}`).set(p.h)).body.data.schedule.status).toBe('paye');
      const statut = await api().get(`/api/v1/locataire/paiements/transactions/${init.body.data.transaction.id}`).set(loc.h);
      expect(statut.body.data.transaction.status).toBe('confirmee');
    });

    test('empreinte invalide : refusée ; empreinte valide mais facture non payée chez PayDunya : sans effet', async () => {
      const { p, loc, echeances, providerId } = await preparer();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const facture = factureDe(init.body.data.transaction.reference);
      const faux = corpsIpn(facture, { empreinteDe: 'a'.repeat(40), annonce: { status: 'completed', total_amount: 350000 } });
      expect((await notifier(providerId, faux)).status).toBe(401);
      const menteuse = corpsIpn(facture, { annonce: { status: 'completed', total_amount: 350000 } });
      expect((await notifier(providerId, menteuse)).body.data).toEqual({ traite: false, motif: 'evenement_ignore' });
      expect((await api().get(`/api/v1/echeances/${echeances[0].id}`).set(p.h)).body.data.schedule.amount_paid).toBe(0);
    });

    test('paiement annulé chez le fournisseur : transaction annulée', async () => {
      const { loc, echeances, providerId } = await preparer();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'orange_money' });
      await notifier(providerId, ipn(init.body.data.transaction.reference, 350000, 'cancelled'));
      const statut = await api().get(`/api/v1/locataire/paiements/transactions/${init.body.data.transaction.id}`).set(loc.h);
      expect(statut.body.data.transaction.status).toBe('annulee');
    });

    test('montant supérieur : excédent en attente, imputé à l’échéance suivante APRÈS confirmation du propriétaire', async () => {
      const { p, loc, echeances, providerId } = await preparer();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await notifier(providerId, ipn(init.body.data.transaction.reference, 500000));
      expect((await api().get(`/api/v1/echeances/${echeances[0].id}`).set(p.h)).body.data.schedule.status).toBe('paye');
      expect((await api().get(`/api/v1/echeances/${echeances[1].id}`).set(p.h)).body.data.schedule.amount_paid).toBe(0);
      const file = await api().get('/api/v1/paiements/rapprochements?type=excedent').set(p.h);
      expect(file.body.data.items[0].amount).toBe(150000);
      const ok = await api().post(`/api/v1/paiements/rapprochements/${file.body.data.items[0].id}/resoudre`).set(p.h).send({});
      expect(ok.status).toBe(200);
      expect((await api().get(`/api/v1/echeances/${echeances[1].id}`).set(p.h)).body.data.schedule.amount_paid).toBe(150000);
    });

    test('montant inférieur : PARTIELLEMENT PAYÉ, le solde reste dû', async () => {
      const { p, loc, echeances, providerId } = await preparer();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave', amount: 100000 });
      await notifier(providerId, ipn(init.body.data.transaction.reference, 100000));
      const e = (await api().get(`/api/v1/echeances/${echeances[0].id}`).set(p.h)).body.data.schedule;
      expect(e.amount_paid).toBe(100000);
      expect(e.status).not.toBe('paye');
    });

    test('paiement sans référence exploitable → file « À rapprocher » → résolu vers un bail', async () => {
      const { p, lease, providerId } = await preparer();
      const ref = `INCONNUE-${crypto.randomBytes(3).toString('hex')}`;
      const res = await notifier(providerId, ipn(ref, 42000));
      expect(res.body.data.a_rapprocher).toBe(true);
      // Même notification rejouée : pas de seconde entrée.
      await notifier(providerId, ipn(ref, 42000));
      const file = await api().get('/api/v1/paiements/rapprochements?type=non_identifie').set(p.h);
      expect(file.body.data.items).toHaveLength(1);
      const r = await api().post(`/api/v1/paiements/rapprochements/${file.body.data.items[0].id}/resoudre`).set(p.h).send({ lease_id: lease.id });
      expect(r.status).toBe(200);
      const [[{ total }]] = await sequelize.query('SELECT sum(amount)::bigint AS total FROM rent_payments WHERE lease_id = :id', { replacements: { id: lease.id } });
      expect(total).toBe(42000);
    });

    test('un autre propriétaire ne peut pas résoudre l’entrée (403)', async () => {
      const { p, providerId } = await preparer();
      const autre = await nouveauProprietaire();
      await notifier(providerId, ipn(`X-${crypto.randomBytes(3).toString('hex')}`, 1000));
      const file = await api().get('/api/v1/paiements/rapprochements').set(p.h);
      expect((await api().post(`/api/v1/paiements/rapprochements/${file.body.data.items[0].id}/rejeter`).set(autre.h).send({ note: 'pas à moi' })).status).toBe(403);
    });
  });

  test('Wave direct : signature vérifiée sur le corps brut', async () => {
    const p = await nouveauProprietaire();
    const bail = await bailActif(p);
    const moyen = await api().put('/api/v1/paiements/moyens').set(p.h)
      .send({ provider: 'wave', mode: 'integre', credentials: { api_key: 'wave_api_key_test', webhook_secret: 'wave_webhook_secret' } });
    const echeances = await echeancesDu(p, bail.lease.id);
    const [[tx]] = await sequelize.query(
      `INSERT INTO payment_transactions (owner_id, tenant_id, lease_id, rent_schedule_id, payment_provider_id, provider, wallet, mode, reference, amount, status, initiated_by)
       VALUES (:o, :t, :l, :s, :pp, 'wave', 'wave', 'integre', :ref, 350000, 'en_attente', :u) RETURNING id, reference`,
      { replacements: { o: p.ownerId, t: bail.tenant.id, l: bail.lease.id, s: echeances[0].id, pp: moyen.body.data.provider.id, ref: `TRX-W-${Date.now()}`, u: p.user.id } }
    );
    const corps = JSON.stringify({ type: 'checkout.session.completed', data: { id: 'cos_1', client_reference: tx.reference, amount: '350000', payment_status: 'succeeded', transaction_id: `T_${Date.now()}` } });
    const t = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', 'wave_webhook_secret').update(`${t}${corps}`).digest('hex');
    const mauvais = await api().post(`/api/v1/webhooks/wave/${moyen.body.data.provider.id}`).set('Content-Type', 'application/json').set('Wave-Signature', `t=${t},v1=${'0'.repeat(64)}`).send(corps);
    expect(mauvais.status).toBe(401);
    const bon = await api().post(`/api/v1/webhooks/wave/${moyen.body.data.provider.id}`).set('Content-Type', 'application/json').set('Wave-Signature', `t=${t},v1=${signature}`).send(corps);
    expect(bon.status).toBe(200);
    expect((await api().get(`/api/v1/echeances/${echeances[0].id}`).set(p.h)).body.data.schedule.status).toBe('paye');
  });

  test('le locataire voit ses paiements et quittances, jamais ceux des autres', async () => {
    const p = await nouveauProprietaire();
    const a = await bailActif(p);
    const b = await bailActif(p);
    const [septA] = await echeancesDu(p, a.lease.id);
    await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: a.lease.id, rent_schedule_id: septA.id, amount: 350000, paid_on: '2026-09-05' });
    const locA = await activerLocataire(p, a.tenant);
    const locB = await activerLocataire(p, b.tenant);
    const qA = await api().get('/api/v1/locataire/quittances').set(locA.h);
    expect(qA.body.data.items).toHaveLength(1);
    expect((await api().get('/api/v1/locataire/quittances').set(locB.h)).body.data.items).toHaveLength(0);
    expect((await api().get(`/api/v1/locataire/quittances/${qA.body.data.items[0].id}/pdf`).set(locB.h)).status).toBe(403);
    const accueil = await api().get('/api/v1/locataire/accueil').set(locA.h);
    expect(accueil.body.data.homes[0].lease.id).toBe(a.lease.id);
    expect(bearer).toBeDefined();
  });
});
