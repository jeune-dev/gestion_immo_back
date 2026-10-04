'use strict';

const crypto = require('crypto');
const { aujourdhui } = require('../../../../utils/dates.js');
const {
  api, nouveauProprietaire, bailActif, activerLocataire, fermer, sequelize, compter,
  desactiverEdlObligatoire, creerImmeuble, creerAppartement, creerLocataire,
} = require('../../../setup/helpers.js');
const {
  ipn, enFormulaire, factureDe, simulerFournisseurs, preparerPaydunya, initier, echeancesDu, soldeCaisse, ligne, lignes,
} = require('./outils.paiements.js');

/**
 * Non-régression des constats d'audit du domaine paiements (chaque test
 * échouait AVANT la correction correspondante).
 */

describe('Corrections d’audit — paiements', () => {
  let fournisseurs;
  beforeAll(() => { fournisseurs = simulerFournisseurs(); });
  afterAll(async () => {
    fournisseurs.restaurer();
    await fermer();
  });

  const webhook = (providerId, corps) => api().post(`/api/v1/webhooks/paydunya/${providerId}`).type('form').send(enFormulaire(corps));

  describe('#1 cible annulée pendant un paiement mobile money en vol', () => {
    test('l’échéance visée est annulée : l’IPN authentique est acquittée (200) et le paiement imputé au plus ancien poste ouvert', async () => {
      const { p, loc, echeances, providerId, lease } = await preparerPaydunya();
      const [sept, oct] = echeances;
      const init = await initier(loc, { rent_schedule_id: sept.id, wallet: 'wave' });
      expect(init.status).toBe(201);
      // Annulation intervenue pendant que le locataire payait (chemin antérieur
      // au verrou PAIEMENT_EN_COURS, ou course avec la fin du bail).
      await sequelize.query("UPDATE rent_schedules SET status = 'annule', cancelled_at = now(), cancel_reason = 'test' WHERE id = :id", { replacements: { id: sept.id } });

      const res = await webhook(providerId, ipn(init.body.data.transaction.reference, 350000));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ traite: true, deja: false });

      const paiement = await ligne('SELECT id, amount, status, transaction_id FROM rent_payments WHERE lease_id = :l', { l: lease.id });
      expect(paiement).toMatchObject({ amount: 350000, status: 'valide', transaction_id: init.body.data.transaction.id });
      const allocs = await lignes('SELECT rent_schedule_id, amount FROM payment_allocations WHERE rent_payment_id = :id', { id: paiement.id });
      expect(allocs).toEqual([{ rent_schedule_id: oct.id, amount: 350000 }]);
      expect(await ligne('SELECT status, amount_paid FROM rent_schedules WHERE id = :id', { id: sept.id })).toEqual({ status: 'annule', amount_paid: 0 });
      expect((await ligne('SELECT status FROM payment_transactions WHERE id = :id', { id: init.body.data.transaction.id })).status).toBe('confirmee');
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 350000, sorties: 0 });
      expect(await compter('reconciliation_entries', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('bail terminé sans aucun poste ouvert : le paiement est enregistré et l’excédent entier part « à décider » (jamais perdu)', async () => {
      const { p, loc, echeances, providerId, lease } = await preparerPaydunya({ bail: { end_date: '2026-09-30' } });
      expect(echeances).toHaveLength(1);
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'orange_money' });
      await sequelize.query("UPDATE rent_schedules SET status = 'annule', cancelled_at = now() WHERE lease_id = :l", { replacements: { l: lease.id } });
      await sequelize.query("UPDATE leases SET status = 'termine' WHERE id = :l", { replacements: { l: lease.id } });

      const res = await webhook(providerId, ipn(init.body.data.transaction.reference, 350000));
      expect(res.status).toBe(200);
      const paiement = await ligne('SELECT id, amount, method FROM rent_payments WHERE lease_id = :l', { l: lease.id });
      expect(paiement).toMatchObject({ amount: 350000, method: 'orange_money' });
      expect(await compter('payment_allocations', 'rent_payment_id = :id', { id: paiement.id })).toBe(0);
      const entree = await ligne("SELECT id, type, status, amount, rent_payment_id, transaction_id FROM reconciliation_entries WHERE owner_id = :o", { o: p.ownerId });
      expect(entree).toMatchObject({ type: 'excedent', status: 'en_attente', amount: 350000, rent_payment_id: paiement.id, transaction_id: init.body.data.transaction.id });

      // Le propriétaire rend l'argent : la caisse s'équilibre exactement.
      const rejet = await api().post(`/api/v1/paiements/rapprochements/${entree.id}/rejeter`).set(p.h).send({ note: 'Bail terminé, argent rendu' });
      expect(rejet.status).toBe(200);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 350000, sorties: 350000 });
    });

    test('annulation d’une échéance refusée (409 PAIEMENT_EN_COURS) tant qu’une demande est initiée / en attente, acceptée ensuite', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const refus = await api().post(`/api/v1/echeances/${echeances[0].id}/annuler`).set(p.h).send({ reason: 'Geste commercial' });
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('PAIEMENT_EN_COURS');
      expect((await ligne('SELECT status FROM rent_schedules WHERE id = :id', { id: echeances[0].id })).status).not.toBe('annule');

      await webhook(providerId, ipn(init.body.data.transaction.reference, 350000, 'cancelled'));
      const ok = await api().post(`/api/v1/echeances/${echeances[0].id}/annuler`).set(p.h).send({ reason: 'Geste commercial' });
      expect(ok.status).toBe(200);
      expect(ok.body.data.schedule.status).toBe('annule');
    });

    test('preuve de paiement en attente : l’échéance ne peut pas être annulée (409 PAIEMENT_EN_COURS)', async () => {
      const p = await nouveauProprietaire();
      const { lease, tenant } = await bailActif(p);
      await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'preuve', account_number: '771112233' });
      const loc = await activerLocataire(p, tenant);
      const [sept] = await echeancesDu(p, lease.id);
      await api().post('/api/v1/locataire/paiements/preuves').set(loc.h).send({ rent_schedule_id: sept.id, wallet: 'wave', provider_transaction_id: `WV-${crypto.randomBytes(4).toString('hex')}`, amount: 350000 });
      const refus = await api().post(`/api/v1/echeances/${sept.id}/annuler`).set(p.h).send({ reason: 'Erreur de saisie' });
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('PAIEMENT_EN_COURS');
    });
  });

  describe('facture annulée chez PayDunya puis payée : jamais imputée automatiquement', () => {
    test('confirmation après une annulation annoncée par PayDunya : rien n’est PAYÉ, l’argent part « À rapprocher » ; rejeu sans doublon ; résolution reliée à la transaction', async () => {
      const { p, loc, echeances, providerId, lease } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      const ref = init.body.data.transaction.reference;
      const capturee = ipn(ref, 350000, 'cancelled');
      await webhook(providerId, capturee);
      expect((await ligne('SELECT raw_payload FROM payment_transactions WHERE id = :id', { id: init.body.data.transaction.id })).raw_payload.annulation_fournisseur).toBe(true);
      // L'IPN d'annulation capturée, rejouée en « completed » : la facture relue
      // est toujours annulée, rien ne se passe.
      const rejeu = await webhook(providerId, { data: { ...capturee.data, status: 'completed' } });
      expect(rejeu.status).toBe(200);
      expect(await compter('reconciliation_entries', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect((await ligne('SELECT status FROM payment_transactions WHERE id = :id', { id: init.body.data.transaction.id })).status).toBe('annulee');

      // Plus tard, la même facture est finalement payée chez PayDunya.
      const r1 = await webhook(providerId, ipn(ref, 350000));
      expect(r1.status).toBe(200);
      expect(r1.body.data.a_rapprocher).toBe(true);
      const r2 = await webhook(providerId, ipn(ref, 350000));
      expect(r2.status).toBe(200);
      expect(await compter('rent_payments', 'lease_id = :l', { l: lease.id })).toBe(0);
      expect((await ligne('SELECT amount_paid FROM rent_schedules WHERE id = :id', { id: echeances[0].id })).amount_paid).toBe(0);
      const entrees = await lignes('SELECT id, type, amount, transaction_id, lease_id, details FROM reconciliation_entries WHERE owner_id = :o', { o: p.ownerId });
      expect(entrees).toHaveLength(1);
      expect(entrees[0]).toMatchObject({ type: 'non_identifie', amount: 350000, transaction_id: init.body.data.transaction.id, lease_id: lease.id });
      expect(entrees[0].details).toMatchObject({ motif: 'confirmation_apres_annulation', id_fournisseur: `paydunya:${factureDe(ref).token}`, reference_recue: ref });
      expect((await ligne('SELECT status FROM payment_transactions WHERE id = :id', { id: init.body.data.transaction.id })).status).toBe('a_rapprocher');

      const res = await api().post(`/api/v1/paiements/rapprochements/${entrees[0].id}/resoudre`).set(p.h).send({ lease_id: lease.id, rent_schedule_id: echeances[0].id });
      expect(res.status).toBe(200);
      const paiement = await ligne('SELECT amount, transaction_id FROM rent_payments WHERE lease_id = :l', { l: lease.id });
      expect(paiement).toEqual({ amount: 350000, transaction_id: init.body.data.transaction.id });
      expect((await ligne('SELECT status FROM payment_transactions WHERE id = :id', { id: init.body.data.transaction.id })).status).toBe('confirmee');
      expect((await ligne('SELECT status FROM rent_schedules WHERE id = :id', { id: echeances[0].id })).status).toBe('paye');
    });

    test('demande seulement EXPIRÉE côté application (sans annonce du fournisseur) : la confirmation tardive est imputée normalement', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await sequelize.query("UPDATE payment_transactions SET expires_at = now() - interval '1 minute' WHERE id = :id", { replacements: { id: init.body.data.transaction.id } });
      const expirees = await require('../../../../modules/paiement/service/paiementLocataire.service.js').expirerDemandes();
      expect(expirees).toBeGreaterThanOrEqual(1);
      const res = await webhook(providerId, ipn(init.body.data.transaction.reference, 350000));
      expect(res.status).toBe(200);
      expect((await api().get(`/api/v1/echeances/${echeances[0].id}`).set(p.h)).body.data.schedule.status).toBe('paye');
    });

    test('une transaction confirmée n’est jamais rétrogradée par une annulation rejouée', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await webhook(providerId, ipn(init.body.data.transaction.reference, 350000));
      const annul = await webhook(providerId, ipn(init.body.data.transaction.reference, 350000, 'cancelled'));
      expect(annul.status).toBe(200);
      expect((await ligne('SELECT status FROM payment_transactions WHERE id = :id', { id: init.body.data.transaction.id })).status).toBe('confirmee');
      expect((await api().get(`/api/v1/echeances/${echeances[0].id}`).set(p.h)).body.data.schedule.status).toBe('paye');
    });
  });

  describe('#2 quittance annulée après remboursement', () => {
    test('le PDF n’est plus visible du locataire (403) ni listé ; le propriétaire le conserve', async () => {
      const p = await nouveauProprietaire();
      const { lease, tenant } = await bailActif(p);
      const loc = await activerLocataire(p, tenant);
      const [sept] = await echeancesDu(p, lease.id);
      const pay = await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, rent_schedule_id: sept.id, amount: 350000, paid_on: '2026-09-05' });
      const recu = await ligne('SELECT id, document_id FROM receipts WHERE rent_schedule_id = :id', { id: sept.id });
      expect((await api().get(`/api/v1/documents/${recu.document_id}/fichier`).set(loc.h)).status).toBe(200);

      expect((await api().post(`/api/v1/paiements/${pay.body.data.payment.id}/rembourser`).set(p.h).send({ reason: 'Erreur de saisie' })).status).toBe(200);

      const refus = await api().get(`/api/v1/documents/${recu.document_id}/fichier`).set(loc.h);
      expect(refus.status).toBe(403);
      expect(refus.body.error.code).toBe('ACCES_DOCUMENT_REFUSE');
      expect((await ligne('SELECT visible_to_tenant FROM documents WHERE id = :id', { id: recu.document_id })).visible_to_tenant).toBe(false);
      expect((await api().get('/api/v1/locataire/quittances').set(loc.h)).body.data.items).toHaveLength(0);
      expect((await api().get(`/api/v1/locataire/quittances/${recu.id}/pdf`).set(loc.h)).status).toBe(404);
      // Conservée pour le propriétaire et l'audit.
      expect((await api().get(`/api/v1/documents/${recu.document_id}/fichier`).set(p.h)).status).toBe(200);
      const toutes = await api().get('/api/v1/quittances?inclure_annulees=true').set(p.h);
      expect(toutes.body.data.items.map((q) => q.id)).toContain(recu.id);
    });
  });

  describe('#4 remboursement d’un paiement dont l’excédent a déjà été rendu', () => {
    test('la sortie de caisse déduit l’excédent déjà rendu : sorties = entrées, au franc près', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await webhook(providerId, ipn(init.body.data.transaction.reference, 500000));
      const [excedent] = (await api().get('/api/v1/paiements/rapprochements?type=excedent').set(p.h)).body.data.items;
      expect(excedent.amount).toBe(150000);
      expect((await api().post(`/api/v1/paiements/rapprochements/${excedent.id}/rejeter`).set(p.h).send({ note: 'Excédent rendu en espèces' })).status).toBe(200);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 500000, sorties: 150000 });

      const paiement = await ligne('SELECT id FROM rent_payments WHERE transaction_id = :t', { t: init.body.data.transaction.id });
      const rb = await api().post(`/api/v1/paiements/${paiement.id}/rembourser`).set(p.h).send({ reason: 'Départ du locataire' });
      expect(rb.status).toBe(200);
      const sorties = await lignes("SELECT amount FROM cash_movements WHERE owner_id = :o AND direction = 'sortie' ORDER BY amount", { o: p.ownerId });
      expect(sorties.map((s) => s.amount)).toEqual([150000, 350000]);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 500000, sorties: 500000 });
      const audit = await ligne("SELECT details FROM audit_logs WHERE action = 'paiement.remboursement' AND entity_id = :id", { id: paiement.id });
      expect(audit.details).toMatchObject({ montant: 500000, montant_rendu: 350000, excedent_deja_rendu: 150000 });
    });

    test('excédent encore EN ATTENTE au remboursement : une seule sortie du montant total, l’entrée est close', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await webhook(providerId, ipn(init.body.data.transaction.reference, 500000));
      const paiement = await ligne('SELECT id FROM rent_payments WHERE transaction_id = :t', { t: init.body.data.transaction.id });
      expect((await api().post(`/api/v1/paiements/${paiement.id}/rembourser`).set(p.h).send({ reason: 'Erreur' })).status).toBe(200);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 500000, sorties: 500000 });
      expect((await ligne("SELECT status, resolution_note FROM reconciliation_entries WHERE rent_payment_id = :id", { id: paiement.id }))).toEqual({ status: 'rejete', resolution_note: 'Paiement remboursé' });
      // Rejeter ensuite l'excédent : déjà traité, aucune seconde sortie.
      const [entree] = (await api().get('/api/v1/paiements/rapprochements?status=rejete').set(p.h)).body.data.items;
      const second = await api().post(`/api/v1/paiements/rapprochements/${entree.id}/rejeter`).set(p.h).send({ note: 'Encore' });
      expect(second.status).toBe(409);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 500000, sorties: 500000 });
    });

    test('concurrence : remboursement du paiement et rejet de l’excédent simultanés → la caisse ne sort jamais plus qu’elle n’a reçu', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      await webhook(providerId, ipn(init.body.data.transaction.reference, 500000));
      const paiement = await ligne('SELECT id FROM rent_payments WHERE transaction_id = :t', { t: init.body.data.transaction.id });
      const [excedent] = (await api().get('/api/v1/paiements/rapprochements?type=excedent').set(p.h)).body.data.items;
      const [a, b] = await Promise.all([
        api().post(`/api/v1/paiements/${paiement.id}/rembourser`).set(p.h).send({ reason: 'Départ' }),
        api().post(`/api/v1/paiements/rapprochements/${excedent.id}/rejeter`).set(p.h).send({ note: 'Rendu' }),
      ]);
      expect(a.status).toBe(200);
      expect([200, 409]).toContain(b.status);
      expect(await soldeCaisse(p.ownerId)).toEqual({ entrees: 500000, sorties: 500000 });
    });
  });

  describe('#20 initiation sans adresses publiques', () => {
    test.each(['API_PUBLIC_URL', 'APP_PUBLIC_URL'])('sans %s : 503 PAIEMENT_NON_CONFIGURE et aucune demande créée', async (variable) => {
      const { loc, echeances } = await preparerPaydunya();
      const valeur = process.env[variable];
      delete process.env[variable];
      try {
        const res = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('PAIEMENT_NON_CONFIGURE');
      } finally {
        process.env[variable] = valeur;
      }
      expect(await compter('payment_transactions', 'rent_schedule_id = :id', { id: echeances[0].id })).toBe(0);
      // L'adresse d'IPN transmise au fournisseur est absolue une fois configurée.
      const ok = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      expect(ok.status).toBe(201);
      const appel = fournisseurs.appels[fournisseurs.appels.length - 1];
      expect(appel.corps.actions.callback_url).toMatch(/^https?:\/\/[^/]+\/api\/v1\/webhooks\/paydunya\/[0-9a-f-]{36}$/);
      // Page de paiement restreinte au portefeuille choisi.
      expect(appel.corps.invoice.channels).toEqual(['wave-senegal']);
    });
  });

  describe('#25 idempotence : un refus passager ne reste pas figé 24 h', () => {
    test('409 BAIL_INVALIDE (bail en brouillon) puis bail activé : la MÊME clé est traitée, pas rejouée', async () => {
      const p = await nouveauProprietaire();
      await desactiverEdlObligatoire(p);
      const immeuble = await creerImmeuble(p);
      const apartment = await creerAppartement(p, immeuble.id);
      const tenant = await creerLocataire(p);
      const brouillon = await api().post('/api/v1/baux').set(p.h).send({ apartment_id: apartment.id, tenant_id: tenant.id, start_date: '2026-10-01', rent_amount: 100000, deposit_amount: 0, due_day: 5 });
      expect(brouillon.status).toBe(201);
      const cle = crypto.randomUUID();
      const corps = { lease_id: brouillon.body.data.lease.id, amount: 100000, paid_on: aujourdhui() };
      const refus = await api().post('/api/v1/paiements/especes').set(p.h).set('Idempotency-Key', cle).send(corps);
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('BAIL_INVALIDE');
      expect(await compter('idempotency_keys', 'key = :k', { k: cle })).toBe(0);

      expect((await api().post(`/api/v1/baux/${brouillon.body.data.lease.id}/activer`).set(p.h).send({})).status).toBe(200);
      const ok = await api().post('/api/v1/paiements/especes').set(p.h).set('Idempotency-Key', cle).send(corps);
      expect(ok.status).toBe(201);
      expect(ok.headers['idempotent-replayed']).toBeUndefined();
      const rejoue = await api().post('/api/v1/paiements/especes').set(p.h).set('Idempotency-Key', cle).send(corps);
      expect(rejoue.status).toBe(201);
      expect(rejoue.headers['idempotent-replayed']).toBe('true');
      expect(await compter('rent_payments', 'lease_id = :l', { l: brouillon.body.data.lease.id })).toBe(1);
    });

    test('un refus DÉFINITIF (422) est conservé et rejoué à l’identique', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p, { bail: { end_date: '2026-09-30' } });
      const cle = crypto.randomUUID();
      const corps = { lease_id: lease.id, amount: 9_000_000, paid_on: '2026-09-05' };
      const a = await api().post('/api/v1/paiements/especes').set(p.h).set('Idempotency-Key', cle).send(corps);
      expect(a.status).toBe(422);
      expect(a.body.error.code).toBe('MONTANT_SUPERIEUR_AU_DU');
      const b = await api().post('/api/v1/paiements/especes').set(p.h).set('Idempotency-Key', cle).send(corps);
      expect(b.status).toBe(422);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.error.code).toBe('MONTANT_SUPERIEUR_AU_DU');
    });
  });
});
