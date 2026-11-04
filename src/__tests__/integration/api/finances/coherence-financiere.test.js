'use strict';

const crypto = require('crypto');
const {
  api, nouveauProprietaire, bailActif, fermer, sequelize, compter, echeancesDu, pngTest,
} = require('../../../setup/helpers.js');
const { WAVE, evenementWave } = require('../paiements/outils.paiements.js');
const { aujourdhui, ajouterJours } = require('../../../../utils/dates.js');

/**
 * Cohérence des process d'argent : doublons, coût des factures communes,
 * provisions, retenues de caution, définitions des KPI et cache du tableau de bord.
 */

const jour = aujourdhui();
const mois = jour.slice(0, 7);
const debut = `${mois}-01`;
const FC = '/api/v1/factures-communes';

const nouveauBail = async (bail = {}) => {
  const p = await nouveauProprietaire();
  const b = await bailActif(p, { bail: { start_date: debut, ...bail } });
  return { p, ...b };
};

const encaisser = (p, corps) => api().post('/api/v1/paiements/especes').set(p.h)
  .set('Idempotency-Key', crypto.randomUUID())
  .send({ paid_on: jour, method: 'especes', ...corps });

const tableau = async (p) => (await api().get('/api/v1/dashboard').set(p.h)).body.data.dashboard;

const facture = (p, building, surcharges = {}) => api().post(FC).set(p.h).send({
  building_id: building.id, charge_type: 'eau', supplier: 'SDE', period_start: debut, period_end: `${mois}-28`,
  amount: 40000, allocation_method: 'egale', recharge_to_tenants: true, ...surcharges,
});

const repartir = (p, id, corps = {}) => api().post(`${FC}/${id}/repartir`).set(p.h).send(corps);

describe('Cohérence financière', () => {
  afterAll(fermer);

  describe('doublons', () => {
    test('webhook sans référence renvoyé : un paiement, aucune entrée « À rapprocher »', async () => {
      const { p, lease, tenant } = await nouveauBail();
      const moyen = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'integre', credentials: WAVE });
      const [e] = await echeancesDu(p, lease.id);
      const donnees = {
        id: `cos_${crypto.randomBytes(3).toString('hex')}`, amount: String(e.amount_due), payment_status: 'succeeded',
        transaction_id: `T_${crypto.randomBytes(4).toString('hex')}`, sender_mobile: tenant.phone,
      };
      const envoyer = async () => {
        const ev = evenementWave(donnees);
        return api().post(`/api/v1/webhooks/wave/${moyen.body.data.provider.id}`)
          .set('Content-Type', 'application/json').set('Wave-Signature', ev.entete).send(ev.corps);
      };
      expect((await envoyer()).body.data.rapproche_par).toBe('montant_telephone');
      const second = await envoyer();
      expect(second.status).toBe(200);
      expect(second.body.data.deja).toBe(true);
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(1);
      expect(await compter('reconciliation_entries', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('encaissement refait sur une échéance soldée : 409, le mois suivant reste intact', async () => {
      const { p, lease } = await nouveauBail();
      const [e, suivante] = await echeancesDu(p, lease.id);
      const corps = { lease_id: lease.id, rent_schedule_id: e.id, amount: e.amount_due };
      expect((await encaisser(p, corps)).status).toBe(201);
      const doublon = await encaisser(p, corps);
      expect(doublon.status).toBe(409);
      expect(doublon.body.error.code).toBe('DEJA_PAYE');
      expect(await compter('rent_payments', 'owner_id = :o', { o: p.ownerId })).toBe(1);
      const apres = await echeancesDu(p, lease.id);
      expect(apres.find((x) => x.id === suivante.id).amount_paid).toBe(0);
    });

    test('même facture sans numéro : 409 ; deux numéros différents : acceptée ; annulée : ressaisie possible', async () => {
      const { p, building } = await nouveauBail();
      const premiere = await facture(p, building);
      expect(premiere.status).toBe(201);
      const doublon = await facture(p, building);
      expect(doublon.status).toBe(409);
      expect(doublon.body.error.code).toBe('FACTURE_EN_DOUBLE');
      expect((await facture(p, building, { supplier: ' sde ' })).status).toBe(409);
      expect((await facture(p, building, { invoice_number: 'A1' })).status).toBe(409);

      const { body } = await facture(p, building, { amount: 41000, invoice_number: 'B1' });
      expect((await facture(p, building, { amount: 41000, invoice_number: 'B2' })).status).toBe(201);
      expect(body.data.invoice.invoice_number).toBe('B1');

      await api().post(`${FC}/${premiere.body.data.invoice.id}/annuler`).set(p.h).send({ reason: 'Saisie erronée' });
      expect((await facture(p, building)).status).toBe(201);
    });
  });

  describe('coût des factures communes', () => {
    test('répartir crée la dépense et la sortie de caisse ; refacturée et payée : résultat nul', async () => {
      const { p, lease, building } = await nouveauBail();
      const inv = (await facture(p, building)).body.data.invoice;
      expect((await repartir(p, inv.id, { payment_method: 'virement' })).status).toBe(200);
      const [[depense]] = await sequelize.query('SELECT amount, method, status FROM expenses WHERE charge_invoice_id = :id', { replacements: { id: inv.id } });
      expect(depense).toEqual({ amount: 40000, method: 'virement', status: 'valide' });

      const [[charge]] = await sequelize.query('SELECT id FROM charges WHERE charge_invoice_id = :id', { replacements: { id: inv.id } });
      expect((await encaisser(p, { lease_id: lease.id, charge_id: charge.id, amount: 40000 })).status).toBe(201);
      const d = await tableau(p);
      expect(d.revenus.charges).toBe(40000);
      expect(d.depenses).toBe(40000);
      expect(d.resultat).toBe(0);

      const rapport = (await api().get(`/api/v1/rapports/financier?du=${debut}&au=${jour}`).set(p.h)).body.data.rapport;
      expect(rapport.benefice_net).toBe(0);
      const rentabilite = (await api().get(`/api/v1/rapports/rentabilite?du=${debut}&au=${jour}`).set(p.h)).body.data;
      const ligne = (rentabilite.rows || rentabilite.lignes || rentabilite.items)[0];
      expect(ligne.charges_communes).toBe(40000);
      expect(ligne.resultat_net).toBe(0);
    });

    test('la dépense se corrige par la facture ; annuler la facture annule dépense et caisse', async () => {
      const { p, building } = await nouveauBail();
      const inv = (await facture(p, building)).body.data.invoice;
      await repartir(p, inv.id);
      const [[depense]] = await sequelize.query('SELECT id FROM expenses WHERE charge_invoice_id = :id', { replacements: { id: inv.id } });
      const refus = await api().post(`/api/v1/depenses/${depense.id}/annuler`).set(p.h).send({ reason: 'Erreur de saisie' });
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('DEPENSE_DE_FACTURE');

      expect((await api().post(`${FC}/${inv.id}/annuler`).set(p.h).send({ reason: 'Facture erronée' })).status).toBe(200);
      expect((await tableau(p)).depenses).toBe(0);
      expect(await compter('cash_movements', 'owner_id = :o AND cancelled_at IS NULL', { o: p.ownerId })).toBe(0);
    });
  });

  describe('provisions de charges', () => {
    const avecProvision = () => nouveauBail({ charges_amount: 10000 });

    test('la provision appelée réduit la part ; elle ne sert qu’une fois', async () => {
      const { p, building, lease } = await avecProvision();
      const a = (await facture(p, building, { invoice_number: 'P1', amount: 6000 })).body.data.invoice;
      const apercu = await api().post(`${FC}/${a.id}/apercu`).set(p.h).send({});
      expect(apercu.body.data.allocation).toMatchObject({ provision_deducted_total: 6000, recharged_total: 0, owner_share: 0 });

      // 6 000 entièrement couverts par la provision : aucune charge à payer.
      await repartir(p, a.id);
      expect(await compter('charges', 'charge_invoice_id = :i', { i: a.id })).toBe(0);

      // Reste 4 000 de provision sur 9 000 : 5 000 à payer.
      const b = (await facture(p, building, { invoice_number: 'P2', amount: 9000 })).body.data.invoice;
      await repartir(p, b.id);
      const [[charge]] = await sequelize.query('SELECT amount, lease_id FROM charges WHERE charge_invoice_id = :i', { replacements: { i: b.id } });
      expect(charge).toEqual({ amount: 5000, lease_id: lease.id });
      const [[ligne]] = await sequelize.query('SELECT amount, provision_deducted, explanation FROM charge_allocations WHERE charge_invoice_id = :i', { replacements: { i: b.id } });
      expect(ligne).toMatchObject({ amount: 9000, provision_deducted: 4000 });
      expect(ligne.explanation).toContain('Provision déjà appelée déduite');

      // Provision épuisée : tout est refacturé.
      const c = (await facture(p, building, { invoice_number: 'P3', amount: 3000 })).body.data.invoice;
      await repartir(p, c.id);
      expect((await sequelize.query('SELECT amount FROM charges WHERE charge_invoice_id = :i', { replacements: { i: c.id } }))[0][0].amount).toBe(3000);
    });

    test('annuler une facture rend sa provision disponible', async () => {
      const { p, building } = await avecProvision();
      const a = (await facture(p, building, { invoice_number: 'R1', amount: 8000 })).body.data.invoice;
      await repartir(p, a.id);
      await api().post(`${FC}/${a.id}/annuler`).set(p.h).send({ reason: 'Facture erronée' });
      const b = (await facture(p, building, { invoice_number: 'R2', amount: 8000 })).body.data.invoice;
      await repartir(p, b.id);
      expect(await compter('charges', 'charge_invoice_id = :i', { i: b.id })).toBe(0);
    });

    test('sans refacturation, rien n’est déduit', async () => {
      const { p, building } = await avecProvision();
      const a = (await facture(p, building, { invoice_number: 'S1', recharge_to_tenants: false, amount: 8000 })).body.data.invoice;
      await repartir(p, a.id);
      const [[ligne]] = await sequelize.query('SELECT provision_deducted FROM charge_allocations WHERE charge_invoice_id = :i', { replacements: { i: a.id } });
      expect(ligne.provision_deducted).toBe(0);
    });
  });

  describe('retenue de caution', () => {
    /** Bail terminé avec un loyer impayé et une caution de 700 000 versée. */
    async function bailTermine() {
      const bail = await nouveauBail();
      const { p, lease } = bail;
      const caution = (await api().get(`/api/v1/cautions?lease_id=${lease.id}`).set(p.h)).body.data.items[0];
      await api().post(`/api/v1/cautions/${caution.id}/versements`).set(p.h).set('Idempotency-Key', crypto.randomUUID())
        .send({ amount: 700000, occurred_on: debut, method: 'especes' });
      const fin = await api().post(`/api/v1/baux/${lease.id}/terminer`).set(p.h).send({ ended_on: jour, termination_reason: 'Départ' });
      expect(fin.status).toBe(200);
      const piece = await api().post(`/api/v1/cautions/${caution.id}/justificatifs`).set(p.h)
        .attach('fichier', await pngTest(), 'piece.png');
      expect(piece.status).toBe(201);
      return { ...bail, caution, documentId: piece.body.data.document.id };
    }
    const retenir = (x, corps) => api().post(`/api/v1/cautions/${x.caution.id}/retenues`).set(x.p.h).set('Idempotency-Key', crypto.randomUUID())
      .send({ description: 'Retenue de fin de bail', justification_document_ids: [x.documentId], ...corps });
    const dus = async (x) => {
      const [[l]] = await sequelize.query("SELECT COALESCE(sum(amount_due - amount_paid), 0) AS reste FROM rent_schedules WHERE lease_id = :l AND status <> 'annule'", { replacements: { l: x.lease.id } });
      return l.reste;
    };
    const synthese = async (x) => {
      const r = await api().get(`/api/v1/caisse/synthese?du=${debut}&au=${jour}`).set(x.p.h);
      return r.body.data.synthese_caisse || r.body.data.synthese || r.body.data.summary || r.body.data.caisse || r.body.data;
    };

    test('pour loyer impayé : solde l’échéance, baisse le solde de caution, entre en revenus', async () => {
      const x = await bailTermine();
      const reste = await dus(x);
      expect(reste).toBeGreaterThan(0);
      const r = await retenir(x, { amount: reste, reason: 'loyer_impaye' });
      expect(r.status).toBe(201);
      expect(r.body.data.transaction.rent_payment_id).toBeTruthy();
      expect(await dus(x)).toBe(0);
      expect(await compter('receipts', 'owner_id = :o', { o: x.p.ownerId })).toBe(1);

      const s = await synthese(x);
      expect(s.cautions).toMatchObject({ recues: 700000, retenues: reste, restituees: 0, solde: 700000 - reste });
      const d = await tableau(x.p);
      expect(d.cautions_detenues).toBe(700000 - reste);
      expect(d.revenus.loyers).toBe(reste);
    });

    test('supérieure aux impayés : refusée, rien n’est écrit', async () => {
      const x = await bailTermine();
      const r = await retenir(x, { amount: (await dus(x)) + 1, reason: 'loyer_impaye' });
      expect(r.status).toBe(422);
      expect(await compter('deposit_transactions', "owner_id = :o AND type = 'retenue'", { o: x.p.ownerId })).toBe(0);
    });

    test('pour dégradation : baisse le solde sans créer de paiement', async () => {
      const x = await bailTermine();
      const r = await retenir(x, { amount: 50000, reason: 'degradation' });
      expect(r.body.data.transaction.rent_payment_id).toBeFalsy();
      expect(await compter('rent_payments', 'owner_id = :o', { o: x.p.ownerId })).toBe(0);
      expect((await synthese(x)).cautions.solde).toBe(650000);
    });

    test('contestation annulée : impayé rouvert, caisse rétablie ; ajustée : nouveau montant', async () => {
      const x = await bailTermine();
      const reste = await dus(x);
      const { body } = await retenir(x, { amount: reste, reason: 'loyer_impaye' });
      const trId = body.data.transaction.id;
      await sequelize.query("UPDATE deposit_transactions SET contest_status = 'conteste' WHERE id = :id", { replacements: { id: trId } });
      const ajustee = await api().post(`/api/v1/cautions/${x.caution.id}/retenues/${trId}/reponse`).set(x.p.h)
        .send({ response: 'Montant revu à la baisse', outcome: 'ajustee', adjusted_amount: 1000 });
      expect(ajustee.status).toBe(200);
      expect(await dus(x)).toBe(reste - 1000);
      expect((await synthese(x)).cautions.retenues).toBe(1000);

      await sequelize.query("UPDATE deposit_transactions SET contest_status = 'conteste', adjusted_amount = NULL WHERE id = :id", { replacements: { id: trId } });
      const annulee = await api().post(`/api/v1/cautions/${x.caution.id}/retenues/${trId}/reponse`).set(x.p.h)
        .send({ response: 'Retenue abandonnée après vérification', outcome: 'annulee' });
      expect(annulee.status).toBe(200);
      expect(await dus(x)).toBe(reste);
      expect((await synthese(x)).cautions).toMatchObject({ retenues: 0, solde: 700000 });
      expect((await tableau(x.p)).revenus.total).toBe(0);
    });

    test('son paiement ne se rembourse pas directement', async () => {
      const x = await bailTermine();
      const { body } = await retenir(x, { amount: await dus(x), reason: 'loyer_impaye' });
      const r = await api().post(`/api/v1/paiements/${body.data.transaction.rent_payment_id}/rembourser`).set(x.p.h)
        .set('Idempotency-Key', crypto.randomUUID()).send({ reason: 'Essai de remboursement', method: 'especes' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('PAIEMENT_DE_RETENUE');
    });
  });

  describe('KPI', () => {
    test('le tableau de bord suit immédiatement un paiement, sans attendre le cache', async () => {
      const { p, lease } = await nouveauBail();
      const [e] = await echeancesDu(p, lease.id);
      expect((await tableau(p)).revenus.total).toBe(0);
      await encaisser(p, { lease_id: lease.id, rent_schedule_id: e.id, amount: e.amount_due });
      expect((await tableau(p)).revenus.total).toBe(e.amount_due);
    });

    test('impayés identiques entre tableau de bord et rapport, délai de grâce compris', async () => {
      const p = await nouveauProprietaire();
      await api().patch('/api/v1/parametres').set(p.h).send({ late_grace_days: 5 });
      const dansLaGrace = ajouterJours(jour, -2);
      const { lease } = await bailActif(p, { bail: { start_date: dansLaGrace, due_day: Number(dansLaGrace.slice(8, 10)) } });
      const [e] = await echeancesDu(p, lease.id);
      const rapport = async () => (await api().get(`/api/v1/rapports/financier?du=${dansLaGrace}&au=${jour}`).set(p.h)).body.data.rapport;
      expect((await tableau(p)).loyers.impayes).toBe(0);
      expect((await rapport()).impayes.montant).toBe(0);

      await sequelize.query("UPDATE rent_schedules SET due_date = :d, status = 'en_retard' WHERE id = :id", { replacements: { d: ajouterJours(jour, -10), id: e.id } });
      expect((await rapport()).impayes.montant).toBe(e.amount_due);
    });

    test('un paiement partiel pas encore échu n’entre pas dans la liste des impayés', async () => {
      const { p, lease } = await nouveauBail();
      const ech = await echeancesDu(p, lease.id);
      const future = ech[1];
      await sequelize.query("UPDATE rent_schedules SET status = 'partiellement_paye', amount_paid = 1 WHERE id = :id", { replacements: { id: future.id } });
      const liste = await api().get(`/api/v1/echeances?lease_id=${lease.id}&impayes=true`).set(p.h);
      expect(liste.status).toBe(200);
      expect(liste.body.data.items.map((x) => x.id)).not.toContain(future.id);
    });

    test('les charges en retard comptent : KPI dédié et liste des débiteurs', async () => {
      const { p, building, tenant } = await nouveauBail();
      const inv = (await facture(p, building, { invoice_number: 'K1' })).body.data.invoice;
      await repartir(p, inv.id);
      await sequelize.query("UPDATE charges SET status = 'en_retard' WHERE charge_invoice_id = :i", { replacements: { i: inv.id } });
      await sequelize.query("UPDATE rent_schedules SET status = 'paye', amount_paid = amount_due WHERE owner_id = :o", { replacements: { o: p.ownerId } });
      await api().patch('/api/v1/parametres').set(p.h).send({ late_grace_days: 0 });
      const d = await tableau(p);
      expect(d.charges_impayees).toBe(40000);
      expect(d.qui_n_a_pas_paye.locataires.find((l) => l.tenant_id === tenant.id).montant).toBe(40000);
    });
  });

  describe('fin de bail', () => {
    test('la période en cours est proratisée à la date de sortie', async () => {
      const { p, lease } = await nouveauBail({ start_date: '2026-09-01' });
      const r = await api().post(`/api/v1/baux/${lease.id}/terminer`).set(p.h).send({ ended_on: '2026-09-10', termination_reason: 'Départ' });
      expect(r.status).toBe(200);
      const ech = await echeancesDu(p, lease.id);
      const sept = ech.find((e) => e.period_start === '2026-09-01');
      expect(sept.period_end).toBe('2026-09-10');
      expect(sept.amount_due).toBe(Math.round((350000 * 10) / 30));
    });
  });
});
