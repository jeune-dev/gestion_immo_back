'use strict';

const { decrypt } = require('../../../../utils/cryptoField.js');
const crypto = require('crypto');
const {
  api, nouveauProprietaire, bailActif, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const {
  PAYDUNYA, PAYDUNYA_PLATEFORME, FACTURES, WAVE, UUID_ABSENT, ipn, corpsIpn, enFormulaire, factureDe, evenementWave,
  simulerFournisseurs, configurerPlateforme, retirerPlateforme, preparerPaydunya, initier, echeancesDu, ligne, lignes, soldeCaisse,
} = require('../paiements/outils.paiements.js');
const app = require('../../../../app.js');

/**
 * Webhooks publics (§ 51, § 31, § 54.3) — authentifiés par SIGNATURE (Wave,
 * WhatsApp) ou par RELECTURE de la facture chez PayDunya :
 *   POST /webhooks/paydunya/:id · POST /webhooks/wave/:id · POST /webhooks/abonnement/paydunya
 *   GET /webhooks/whatsapp · POST /webhooks/whatsapp
 */

// IPN PayDunya au format RÉEL : application/x-www-form-urlencoded, tout sous `data[…]`.
const paydunya = (providerId, corps) => api().post(`/api/v1/webhooks/paydunya/${providerId}`).type('form').send(enFormulaire(corps));
const wave = (providerId, { corps, entete }) => {
  const r = api().post(`/api/v1/webhooks/wave/${providerId}`).set('Content-Type', 'application/json');
  return (entete === undefined ? r : r.set('Wave-Signature', entete)).send(corps);
};

async function preparerWave() {
  const p = await nouveauProprietaire();
  const bail = await bailActif(p);
  const moyen = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'integre', credentials: WAVE });
  const echeances = await echeancesDu(p, bail.lease.id);
  const [[tx]] = await sequelize.query(
    `INSERT INTO payment_transactions (owner_id, tenant_id, lease_id, rent_schedule_id, payment_provider_id, provider, wallet, mode, reference, amount, status, initiated_by)
     VALUES (:o, :t, :l, :s, :pp, 'wave', 'wave', 'integre', :ref, 350000, 'en_attente', :u) RETURNING id, reference`,
    { replacements: { o: p.ownerId, t: bail.tenant.id, l: bail.lease.id, s: echeances[0].id, pp: moyen.body.data.provider.id, ref: `TRX-W-${crypto.randomBytes(5).toString('hex')}`, u: p.user.id } }
  );
  return { p, ...bail, echeances, tx, providerId: moyen.body.data.provider.id };
}

const donneesWave = (tx, surcharges = {}) => ({ id: `cos_${crypto.randomBytes(3).toString('hex')}`, client_reference: tx.reference, amount: '350000', payment_status: 'succeeded', transaction_id: `T_${crypto.randomBytes(4).toString('hex')}`, ...surcharges });

/** Corps d'IPN modifié en profondeur (copie). */
const modifier = (corps, alterer) => {
  const copie = JSON.parse(JSON.stringify(corps));
  alterer(copie.data);
  return copie;
};

describe('Webhooks', () => {
  let fournisseurs;
  beforeAll(() => {
    // Identifiants PayDunya de la PLATEFORME (abonnements), lus à l'appel.
    configurerPlateforme();
    fournisseurs = simulerFournisseurs();
  });
  afterEach(() => fournisseurs.mode('ok'));
  afterAll(async () => {
    fournisseurs.restaurer();
    retirerPlateforme();
    await fermer();
  });

  describe('filet global par IP : les webhooks en sont exclus', () => {
    test('la règle d’exclusion ne vise que /api/v1/webhooks/', () => {
      const { horsLimiteGlobale } = app;
      expect(typeof horsLimiteGlobale).toBe('function');
      expect(horsLimiteGlobale({ originalUrl: `/api/v1/webhooks/paydunya/${UUID_ABSENT}` })).toBe(true);
      expect(horsLimiteGlobale({ originalUrl: '/api/v1/webhooks/abonnement/paydunya' })).toBe(true);
      expect(horsLimiteGlobale({ originalUrl: '/api/v1/webhooks/whatsapp?hub.mode=subscribe' })).toBe(true);
      expect(horsLimiteGlobale({ originalUrl: '/api/v1/paiements' })).toBe(false);
      expect(horsLimiteGlobale({ originalUrl: '/api/v1/auth/connexion' })).toBe(false);
      expect(horsLimiteGlobale({ originalUrl: '/api/v1/webhooksx' })).toBe(false);
      expect(horsLimiteGlobale({ url: '/health' })).toBe(false);
    });
  });

  describe('POST /webhooks/paydunya/:id', () => {
    const refUnique = (prefixe = 'TRX') => `${prefixe}-${crypto.randomBytes(4).toString('hex')}`;
    const statutTx = async (id) => (await ligne('SELECT status FROM payment_transactions WHERE id = :id', { id })).status;

    test('IPN valide (format x-www-form-urlencoded réel) : réponse et effets (paiement, transaction confirmée, caisse, journal par le fournisseur)', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const ref = init.body.data.transaction.reference;
      const res = await paydunya(providerId, ipn(ref, 350000));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, message: 'Notification traitée', data: { traite: true, deja: false, transaction_id: init.body.data.transaction.id } });
      const tx = await ligne('SELECT status, provider_transaction_id, payer_phone, raw_payload FROM payment_transactions WHERE id = :id', { id: init.body.data.transaction.id });
      expect(tx).toMatchObject({ status: 'confirmee', provider_transaction_id: `paydunya:${factureDe(ref).token}` });
      expect(tx.payer_phone).toMatch(/^v1:/); // chiffré au repos (constat M13)
      expect(decrypt(tx.payer_phone)).toBe('+221770000000');
      // La charge conservée est la facture RELUE chez PayDunya, pas le corps de l'IPN.
      expect(tx.raw_payload).toMatchObject({ status: 'completed', invoice: { token: factureDe(ref).token, total_amount: 350000 } });
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 350000, sorties: 0 });
      const audit = await ligne("SELECT actor_role FROM audit_logs WHERE action = 'paiement.paiement' AND owner_id = :o", { o: p.ownerId });
      expect(audit.actor_role).toBe('fournisseur_paiement');
    });

    test('IPN en JSON également acceptée', async () => {
      const { loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const res = await api().post(`/api/v1/webhooks/paydunya/${providerId}`).send(ipn(init.body.data.transaction.reference, 350000));
      expect(res.status).toBe(200);
      expect(res.body.data.traite).toBe(true);
    });

    test.each([
      ['empreinte absente', (c) => modifier(c, (d) => { delete d.hash; })],
      ['empreinte fausse', (c) => modifier(c, (d) => { d.hash = 'f'.repeat(128); })],
      ['empreinte tronquée', (c) => modifier(c, (d) => { d.hash = d.hash.slice(0, 10); })],
      ['jeton de facture absent', (c) => modifier(c, (d) => { delete d.invoice.token; })],
      ['jeton de facture malformé', (c) => modifier(c, (d) => { d.invoice.token = '../../confirm/x'; })],
      ['empreinte d’une autre clé principale', (_c, ref) => ipn(ref, 350000, 'completed', { empreinteDe: 'autre-cle-principale' })],
    ])('refus 401 SIGNATURE_INVALIDE — %s ; rien n’est modifié', async (_l, alterer) => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const ref = init.body.data.transaction.reference;
      const res = await paydunya(providerId, alterer(ipn(ref, 350000), ref));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SIGNATURE_INVALIDE');
      expect(await statutTx(init.body.data.transaction.id)).toBe('en_attente');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect(await compter('reconciliation_entries', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('IPN menteuse (empreinte valide) : annonce « completed » alors que la facture est EN ATTENTE chez PayDunya → rien n’est confirmé', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const facture = factureDe(init.body.data.transaction.reference);
      expect(facture.status).toBe('pending');
      const res = await paydunya(providerId, corpsIpn(facture, { annonce: { status: 'completed', total_amount: 350000 } }));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ traite: false, motif: 'evenement_ignore' });
      expect(await statutTx(init.body.data.transaction.id)).toBe('en_attente');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 0, sorties: 0 });
    });

    test('montant annoncé falsifié : seul le montant de la facture relue chez PayDunya est imputé', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave', amount: 200000 });
      const corps = modifier(ipn(init.body.data.transaction.reference, 200000), (d) => { d.invoice.total_amount = '350000'; });
      expect((await paydunya(providerId, corps)).status).toBe(200);
      expect((await ligne('SELECT amount FROM rent_payments WHERE owner_id = :o', { o: p.ownerId })).amount).toBe(200000);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 200000, sorties: 0 });
      const e = await ligne('SELECT status, amount_paid FROM rent_schedules WHERE id = :id', { id: echeances[0].id });
      expect(e.amount_paid).toBe(200000);
      expect(e.status).not.toBe('paye');
    });

    test('IPN capturée puis rejouée avec un autre statut et un autre montant : sans effet (la facture est relue)', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const capturee = ipn(init.body.data.transaction.reference, 350000, 'cancelled');
      expect((await paydunya(providerId, capturee)).status).toBe(200);
      expect(await statutTx(init.body.data.transaction.id)).toBe('annulee');
      const rejouee = modifier(capturee, (d) => { d.status = 'completed'; d.invoice.total_amount = '350000'; });
      const res = await paydunya(providerId, rejouee);
      expect(res.status).toBe(200);
      expect(await statutTx(init.body.data.transaction.id)).toBe('annulee');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect(await compter('reconciliation_entries', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('PayDunya injoignable pendant la relecture → 503 FOURNISSEUR_INDISPONIBLE, rien ne change ; la notification renvoyée ensuite est traitée', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const corps = ipn(init.body.data.transaction.reference, 350000);
      fournisseurs.mode('panne_relecture');
      const res = await paydunya(providerId, corps);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('FOURNISSEUR_INDISPONIBLE');
      expect(await statutTx(init.body.data.transaction.id)).toBe('en_attente');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      fournisseurs.mode('ok');
      expect((await paydunya(providerId, corps)).body.data).toMatchObject({ traite: true, deja: false });
      expect(await statutTx(init.body.data.transaction.id)).toBe('confirmee');
    });

    test('facture inconnue de PayDunya (empreinte pourtant valide) → notification non acquittée (503), rien n’est modifié', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const corps = modifier(ipn(init.body.data.transaction.reference, 350000), (d) => { d.invoice.token = 'test_inexistante'; });
      expect((await paydunya(providerId, corps)).status).toBe(503);
      expect(await statutTx(init.body.data.transaction.id)).toBe('en_attente');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect(await compter('reconciliation_entries', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('référence absente des données personnalisées : transaction retrouvée par le jeton de facture enregistré', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const facture = factureDe(init.body.data.transaction.reference);
      Object.assign(facture, { status: 'completed', total_amount: 350000, custom_data: {}, customer: { phone: '221770000000' } });
      const res = await paydunya(providerId, corpsIpn(facture));
      expect(res.body.data).toEqual({ traite: true, deja: false, transaction_id: init.body.data.transaction.id });
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(1);
    });

    test('compte PayDunya en production : un paiement de TEST est refusé (401) ; un paiement de production est accepté', async () => {
      const p = await nouveauProprietaire();
      await bailActif(p);
      const production = { master_key: `cle-principale-prod-${crypto.randomBytes(4).toString('hex')}`, private_key: 'live_private_cle_de_production_01', token: 'jeton-de-production-01', mode: 'live' };
      const moyen = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: production });
      expect(moyen.status).toBe(200);
      const id = moyen.body.data.provider.id;
      const test = await paydunya(id, ipn(refUnique(), 1000, 'completed', { cles: production, mode: 'test' }));
      expect(test.status).toBe(401);
      expect(test.body.error.code).toBe('SIGNATURE_INVALIDE');
      expect(await compter('reconciliation_entries', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      const live = await paydunya(id, ipn(refUnique(), 1000, 'completed', { cles: production, telephone: '221700000777' }));
      expect(live.status).toBe(200);
      expect(live.body.data.a_rapprocher).toBe(true);
      // Relecture sur l'API de PRODUCTION.
      expect(fournisseurs.appels.some((a) => /\/api\/v1\/checkout-invoice\/confirm\/live_/.test(a.url))).toBe(true);
    });

    test('moyen inconnu → 404 ; identifiant invalide → 422 ; moyen Wave ou « preuve » sur la route PayDunya → 404', async () => {
      expect((await paydunya(UUID_ABSENT, ipn(refUnique(), 1000))).status).toBe(404);
      expect((await paydunya('pas-un-uuid', ipn(refUnique(), 1000))).status).toBe(422);
      const { providerId } = await preparerWave();
      expect((await paydunya(providerId, ipn(refUnique(), 1000))).status).toBe(404);
      const p = await nouveauProprietaire();
      const preuve = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'preuve', account_number: '771112233' });
      expect((await api().post(`/api/v1/webhooks/wave/${preuve.body.data.provider.id}`).set('Content-Type', 'application/json').send('{}')).status).toBe(404);
    });

    test('facture encore en attente : acquittée sans effet ; montant inexploitable sur la facture : acquitté, rien n’est enregistré', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const ref = init.body.data.transaction.reference;
      const attente = await paydunya(providerId, ipn(ref, 350000, 'pending'));
      expect(attente.status).toBe(200);
      expect(attente.body.data).toEqual({ traite: false, motif: 'evenement_ignore' });
      const invalide = await paydunya(providerId, ipn(ref, 'abc'));
      expect(invalide.status).toBe(200);
      expect(invalide.body.data).toEqual({ traite: false, motif: 'montant_invalide' });
      const zero = await paydunya(providerId, ipn(ref, 0));
      expect(zero.body.data.motif).toBe('montant_invalide');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect(await statutTx(init.body.data.transaction.id)).toBe('en_attente');
    });

    test('isolation : la facture d’un AUTRE propriétaire, notifiée sur ce moyen, n’atteint jamais la transaction d’autrui', async () => {
      const a = await preparerPaydunya();
      const b = await preparerPaydunya();
      const init = await initier(a.loc, { rent_schedule_id: a.echeances[0].id, wallet: 'wave' });
      const res = await paydunya(b.providerId, ipn(init.body.data.transaction.reference, 350000, 'completed', { telephone: '221700000999' }));
      expect(res.status).toBe(200);
      expect(res.body.data.a_rapprocher).toBe(true);
      expect(await statutTx(init.body.data.transaction.id)).toBe('en_attente');
      expect(await compter('rent_payments', 'owner_id = :o', { o: a.p.ownerId })).toBe(0);
      expect(await compter('reconciliation_entries', 'owner_id = :o', { o: b.p.ownerId })).toBe(1);
    });

    test('§ 44 / § 51.3 concurrence : cinq IPN identiques simultanées → un seul paiement, toutes acquittées', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const corps = ipn(init.body.data.transaction.reference, 350000);
      const reponses = await Promise.all(Array.from({ length: 5 }, () => paydunya(providerId, corps)));
      expect(reponses.every((r) => r.status === 200)).toBe(true);
      expect(reponses.filter((r) => r.body.data.deja === false)).toHaveLength(1);
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(1);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 350000, sorties: 0 });
      expect(await compter('receipts', 'owner_id = :o', { o: p.ownerId })).toBe(1);
    });

    test('concurrence : paiement non identifié notifié plusieurs fois simultanément → une seule entrée « À rapprocher »', async () => {
      const { p, providerId } = await preparerPaydunya();
      const corps = ipn(refUnique('INCONNUE'), 12345, 'completed', { telephone: '221700000888' });
      const reponses = await Promise.all(Array.from({ length: 4 }, () => paydunya(providerId, corps)));
      expect(reponses.every((r) => r.status === 200)).toBe(true);
      expect(await compter('reconciliation_entries', 'owner_id = :o', { o: p.ownerId })).toBe(1);
      expect(await compter('notifications', "user_id = :u AND title = 'Paiement à rapprocher'", { u: p.user.id })).toBe(1);
    });

    test('§ 44 paiement annulé chez PayDunya : transaction annulée (marquée par le fournisseur), échéance intacte ; annulation sans référence connue : acquittée', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const res = await paydunya(providerId, ipn(init.body.data.transaction.reference, 350000, 'cancelled'));
      expect(res.status).toBe(200);
      const tx = await ligne('SELECT status, cancelled_at, raw_payload FROM payment_transactions WHERE id = :id', { id: init.body.data.transaction.id });
      expect(tx.status).toBe('annulee');
      expect(tx.raw_payload.annulation_fournisseur).toBe(true);
      expect(await compter('audit_logs', "action = 'paiement.changement_statut' AND entity_id = :id", { id: init.body.data.transaction.id })).toBe(1);
      const echec = await paydunya(providerId, ipn(refUnique(), 1000, 'failed'));
      expect(echec.status).toBe(200);
      expect(echec.body.data.traite).toBe(false);
      const inconnue = await paydunya(providerId, ipn(refUnique(), 1000, 'cancelled'));
      expect(inconnue.status).toBe(200);
      expect(inconnue.body.data.traite).toBe(false);
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect((await ligne('SELECT status FROM rent_schedules WHERE id = :id', { id: echeances[0].id })).status).not.toBe('paye');
    });
  });

  describe('POST /webhooks/wave/:id', () => {
    test('événement signé sur le corps brut : PAYÉ ; rejoué → traité une seule fois', async () => {
      const { p, echeances, tx, providerId } = await preparerWave();
      const evt = evenementWave(donneesWave(tx, { sender_mobile: '+221771234567' }));
      const r1 = await wave(providerId, evt);
      expect(r1.status).toBe(200);
      expect(r1.body.data).toMatchObject({ traite: true, deja: false });
      const r2 = await wave(providerId, evt);
      expect(r2.body.data.deja).toBe(true);
      expect((await ligne('SELECT status FROM rent_schedules WHERE id = :id', { id: echeances[0].id })).status).toBe('paye');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(1);
      const confirmee = await ligne('SELECT payer_phone, status FROM payment_transactions WHERE id = :id', { id: tx.id });
      expect(confirmee.status).toBe('confirmee');
      expect(decrypt(confirmee.payer_phone)).toBe('+221771234567');
    });

    test('échec de paiement Wave → transaction annulée ; type non géré → ignoré', async () => {
      const { tx, providerId } = await preparerWave();
      const ignore = await wave(providerId, evenementWave(donneesWave(tx), { type: 'merchant.payment_received' }));
      expect(ignore.body.data.traite).toBe(false);
      const echec = await wave(providerId, evenementWave(donneesWave(tx, { payment_status: 'failed' }), { type: 'checkout.session.payment_failed' }));
      expect(echec.status).toBe(200);
      expect((await ligne('SELECT status FROM payment_transactions WHERE id = :id', { id: tx.id })).status).toBe('annulee');
    });

    test.each([
      ['en-tête absent', (e) => ({ ...e, entete: undefined })],
      ['signature fausse', (e) => ({ ...e, entete: e.entete.replace(/v1=[0-9a-f]+/, `v1=${'0'.repeat(64)}`) })],
      ['corps modifié après signature', (e) => ({ ...e, corps: e.corps.replace('350000', '999999') })],
      ['horodatage trop ancien (rejeu)', () => null],
      ['horodatage non numérique', () => 'non-numerique'],
      ['deux horodatages', (e) => ({ ...e, entete: `t=abc,${e.entete}` })],
    ])('refus 401 — %s ; rien n’est payé', async (_l, alterer) => {
      const { p, tx, providerId } = await preparerWave();
      const data = donneesWave(tx);
      let evt = alterer(evenementWave(data));
      if (evt === null) evt = evenementWave(data, { t: Math.floor(Date.now() / 1000) - 3600 });
      if (evt === 'non-numerique') {
        const corps = JSON.stringify({ type: 'checkout.session.completed', data });
        evt = { corps, entete: `t=abc,v1=${crypto.createHmac('sha256', WAVE.webhook_secret).update(`abc${corps}`).digest('hex')}` };
      }
      const res = await wave(providerId, evt);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SIGNATURE_INVALIDE');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('corps illisible : JSON invalide → 400 ; sans corps JSON → 400 CORPS_ABSENT', async () => {
      const { providerId } = await preparerWave();
      const json = await api().post(`/api/v1/webhooks/wave/${providerId}`).set('Content-Type', 'application/json').send('{pas du json');
      expect(json.status).toBe(400);
      const vide = await api().post(`/api/v1/webhooks/wave/${providerId}`).set('Content-Type', 'text/plain').send('bonjour');
      expect(vide.status).toBe(400);
      expect(vide.body.error.code).toBe('CORPS_ABSENT');
    });

    test('concurrence : même événement Wave reçu simultanément → un seul paiement', async () => {
      const { p, tx, providerId } = await preparerWave();
      const evt = evenementWave(donneesWave(tx));
      const reponses = await Promise.all([1, 2, 3].map(() => wave(providerId, evt)));
      expect(reponses.every((r) => r.status === 200)).toBe(true);
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(1);
    });
  });

  describe('POST /webhooks/abonnement/paydunya', () => {
    const URL_ABO = '/api/v1/webhooks/abonnement/paydunya';
    const notifierAbo = (corps) => api().post(URL_ABO).type('form').send(enFormulaire(corps));
    const ipnPlateforme = (reference, montant, statut = 'completed', o = {}) => ipn(reference, montant, statut, { cles: PAYDUNYA_PLATEFORME, ...o });

    test('IPN valide → 200 et abonnement activé ; empreinte fausse, clés d’un propriétaire ou référence inconnue → 400 NOTIFICATION_REFUSEE', async () => {
      const p = await nouveauProprietaire();
      const sous = await api().post('/api/v1/abonnement/souscrire').set(p.h).send({ plan_code: 'STARTER', months: 1 });
      const { reference, amount } = sous.body.data.payment;
      const faux = await notifierAbo(ipnPlateforme(reference, amount, 'completed', { empreinteDe: 'mauvaise-cle' }));
      expect(faux.status).toBe(400);
      expect(faux.body.error.code).toBe('NOTIFICATION_REFUSEE');
      // Empreinte des clés d'un PROPRIÉTAIRE : jamais valable pour la plateforme.
      expect((await notifierAbo(ipnPlateforme(reference, amount, 'completed', { empreinteDe: PAYDUNYA.master_key }))).status).toBe(400);
      const inconnue = await notifierAbo(ipnPlateforme(`ABO-INCONNUE-${crypto.randomBytes(3).toString('hex')}`, amount));
      expect(inconnue.status).toBe(400);
      expect((await ligne("SELECT status FROM subscriptions WHERE owner_id = :o AND status IN ('essai','actif')", { o: p.ownerId })).status).toBe('essai');
      const ok = await notifierAbo(ipnPlateforme(reference, amount));
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ success: true, message: 'Notification traitée' });
      expect((await ligne("SELECT status FROM subscriptions WHERE owner_id = :o AND status IN ('essai','actif')", { o: p.ownerId })).status).toBe('actif');
      expect((await notifierAbo(ipnPlateforme(reference, amount))).status).toBe(200);
    });

    test('facture PayDunya étrangère à ce paiement (autre jeton, même référence) → 400, abonnement non activé', async () => {
      const p = await nouveauProprietaire();
      const { reference, amount } = (await api().post('/api/v1/abonnement/souscrire').set(p.h).send({ plan_code: 'STARTER', months: 1 })).body.data.payment;
      const originale = factureDe(reference);
      expect((await ligne('SELECT provider_transaction_id FROM subscription_payments WHERE reference = :r', { r: reference })).provider_transaction_id).toBe(`paydunya:${originale.token}`);
      const etrangere = { ...originale, token: `test_${crypto.randomBytes(5).toString('hex')}`, status: 'completed', total_amount: Number(amount) };
      FACTURES.set(etrangere.token, etrangere);
      const res = await notifierAbo(corpsIpn(etrangere, { empreinteDe: PAYDUNYA_PLATEFORME.master_key }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('NOTIFICATION_REFUSEE');
      expect((await ligne('SELECT status FROM subscription_payments WHERE reference = :r', { r: reference })).status).toBe('initie');
      expect((await ligne("SELECT status FROM subscriptions WHERE owner_id = :o AND status IN ('essai','actif')", { o: p.ownerId })).status).toBe('essai');
    });

    test('PayDunya injoignable pendant la relecture → 503 FOURNISSEUR_INDISPONIBLE, rien ne change', async () => {
      const p = await nouveauProprietaire();
      const { reference, amount } = (await api().post('/api/v1/abonnement/souscrire').set(p.h).send({ plan_code: 'STARTER', months: 1 })).body.data.payment;
      const corps = ipnPlateforme(reference, amount);
      fournisseurs.mode('panne_relecture');
      const res = await notifierAbo(corps);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('FOURNISSEUR_INDISPONIBLE');
      expect((await ligne('SELECT status FROM subscription_payments WHERE reference = :r', { r: reference })).status).toBe('initie');
      fournisseurs.mode('ok');
      expect((await notifierAbo(corps)).status).toBe(200);
    });

    test('plateforme non configurée : 400 (aucun effet)', async () => {
      retirerPlateforme();
      try {
        const res = await notifierAbo(ipnPlateforme(`ABO-X-${crypto.randomBytes(3).toString('hex')}`, 5000));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('NOTIFICATION_REFUSEE');
      } finally {
        configurerPlateforme();
      }
    });

    test('concurrence : IPN identiques simultanées → une seule prolongation', async () => {
      const p = await nouveauProprietaire();
      const sous = await api().post('/api/v1/abonnement/souscrire').set(p.h).send({ plan_code: 'STARTER', months: 2 });
      const { reference, amount } = sous.body.data.payment;
      const corps = ipnPlateforme(reference, amount);
      const reponses = await Promise.all([1, 2, 3, 4].map(() => notifierAbo(corps)));
      expect(reponses.every((r) => r.status === 200)).toBe(true);
      expect(await compter('audit_logs', "action = 'abonnement.paiement' AND owner_id = :o", { o: p.ownerId })).toBe(1);
      const ab = await ligne("SELECT current_period_start, current_period_end FROM subscriptions WHERE owner_id = :o AND status = 'actif'", { o: p.ownerId });
      const { ajouterMois } = require('../../../../utils/dates.js');
      expect(ab.current_period_end).toBe(ajouterMois(ab.current_period_start, 2));
    });
  });

  describe('WhatsApp (§ 54.3)', () => {
    afterEach(() => {
      delete process.env.WHATSAPP_VERIFY_TOKEN;
      delete process.env.WHATSAPP_APP_SECRET;
    });

    test('GET vérification : bon jeton → challenge en texte ; mauvais jeton, mode absent ou non configuré → 403', async () => {
      process.env.WHATSAPP_VERIFY_TOKEN = 'jeton-verif-123';
      const ok = await api().get('/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=jeton-verif-123&hub.challenge=424242');
      expect(ok.status).toBe(200);
      expect(ok.headers['content-type']).toMatch(/^text\/plain/);
      expect(ok.text).toBe('424242');
      for (const qs of ['hub.mode=subscribe&hub.verify_token=faux-jeton-123&hub.challenge=1', 'hub.verify_token=jeton-verif-123&hub.challenge=1', 'hub.mode=subscribe&hub.challenge=1']) {
        const res = await api().get(`/api/v1/webhooks/whatsapp?${qs}`);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('VERIFICATION_REFUSEE');
      }
      // CORRECTIF : caractères multi-octets de même longueur en CARACTÈRES que le
      // jeton (15) — auparavant timingSafeEqual levait une exception (500).
      const multiOctets = encodeURIComponent('é'.repeat('jeton-verif-123'.length));
      expect((await api().get(`/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${multiOctets}&hub.challenge=1`)).status).toBe(403);
      delete process.env.WHATSAPP_VERIFY_TOKEN;
      expect((await api().get('/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).status).toBe(403);
    });

    test('POST statuts signés : progression envoyé → distribué → lu, jamais de régression ; échec avec motif ; signature fausse → 401', async () => {
      process.env.WHATSAPP_APP_SECRET = 'secret-meta-test';
      const p = await nouveauProprietaire();
      const idMeta = `wamid.${crypto.randomBytes(6).toString('hex')}`;
      const idEchec = `wamid.${crypto.randomBytes(6).toString('hex')}`;
      await sequelize.query(
        "INSERT INTO message_deliveries (owner_id, channel, status, provider_message_id) VALUES (:o, 'whatsapp', 'envoye', :a), (:o, 'whatsapp', 'envoye', :b)",
        { replacements: { o: p.ownerId, a: idMeta, b: idEchec } }
      );
      const envoyer = (statuses, secret = 'secret-meta-test') => {
        const corps = JSON.stringify({ entry: [{ changes: [{ value: { statuses } }] }] });
        const signature = `sha256=${crypto.createHmac('sha256', secret).update(corps).digest('hex')}`;
        return api().post('/api/v1/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(corps);
      };
      const ts = String(Math.floor(Date.now() / 1000));
      const faux = await envoyer([{ id: idMeta, status: 'read', timestamp: ts }], 'autre');
      expect(faux.status).toBe(401);
      const lu = await envoyer([{ id: idMeta, status: 'read', timestamp: ts }, { id: idEchec, status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }, { id: 'inconnu', status: 'read' }, { id: idMeta, status: 'bizarre' }]);
      expect(lu.status).toBe(200);
      expect(lu.body.data).toEqual({ mis_a_jour: 2 });
      const regression = await envoyer([{ id: idMeta, status: 'delivered', timestamp: ts }]);
      expect(regression.body.data).toEqual({ mis_a_jour: 0 });
      const lignesMaj = await lignes('SELECT provider_message_id, status, error, read_at FROM message_deliveries WHERE provider_message_id IN (:ids) ORDER BY status', { ids: [idMeta, idEchec] });
      expect(lignesMaj).toEqual([
        { provider_message_id: idEchec, status: 'echec', error: '131026 Message undeliverable', read_at: null },
        { provider_message_id: idMeta, status: 'lu', error: null, read_at: expect.any(Date) },
      ]);
    });
  });
});
