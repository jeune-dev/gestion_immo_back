'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, bailActif, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * Audit #1 (HAUTE) — annulation d'une facture commune répartie alors qu'un
 * paiement de charge peut encore être confirmé.
 *
 * Le job d'expiration passe « annulee » une demande intégrée échue, mais le
 * fournisseur (Wave / Orange Money) peut confirmer TARDIVEMENT (§ 51.3). Si la
 * facture était annulée entre-temps, la confirmation créditerait une charge
 * annulée. Règle : pas d'annulation tant qu'une transaction sur ces charges
 * est initiée / en attente, OU annulée depuis moins de 24 h → 409
 * PAIEMENT_EN_COURS, sans aucune écriture.
 */

jest.setTimeout(60000);

const FC = '/api/v1/factures-communes';
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

describe('Annulation de facture et confirmation tardive d’un paiement de charge', () => {
  let proprio;
  let bail;

  beforeAll(async () => {
    proprio = await nouveauProprietaire();
    bail = await bailActif(proprio);
  });
  afterAll(fermer);

  /** Facture répartie sur l'immeuble du bail : une charge pour l'appartement occupé. */
  async function factureRepartie() {
    const creation = await api().post(FC).set(proprio.h).send({
      building_id: bail.building.id, charge_type: 'eau', supplier: 'SEN’EAU',
      period_start: '2026-09-01', period_end: '2026-09-30', amount: 30000, allocation_method: 'egale',
    });
    expect(creation.status).toBe(201);
    const id = creation.body.data.invoice.id;
    expect((await api().post(`${FC}/${id}/repartir`).set(proprio.h).send({})).status).toBe(200);
    const [charge] = await q('SELECT * FROM charges WHERE charge_invoice_id = :id', { id });
    expect(charge).toBeTruthy();
    return { id, charge };
  }

  async function transactionSurCharge(charge, statut, creeeIlYa = '0 minutes') {
    await q(`
      INSERT INTO payment_transactions (owner_id, tenant_id, lease_id, charge_id, provider, wallet, mode, reference, amount,
                                        status, expires_at, cancelled_at, initiated_by, created_at)
      VALUES (:o, :t, :l, :c, 'paydunya', 'wave', 'integre', :ref, :montant, :statut,
              now() - CAST(:age AS interval) + interval '15 minutes',
              CASE WHEN :statut = 'annulee' THEN now() END, :u, now() - CAST(:age AS interval))`, {
      o: proprio.ownerId, t: charge.tenant_id, l: charge.lease_id, c: charge.id, ref: `TX-${crypto.randomBytes(6).toString('hex')}`,
      montant: charge.amount, statut, age: creeeIlYa, u: proprio.user.id,
    });
  }

  const etat = async (id) => ({
    facture: (await q('SELECT status FROM charge_invoices WHERE id = :id', { id }))[0].status,
    charges: (await q('SELECT DISTINCT status FROM charges WHERE charge_invoice_id = :id', { id })).map((c) => c.status),
    audit: (await q("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = :id AND action = 'facture_commune.changement_statut'", { id }))[0].n,
  });

  test('transaction expirée (« annulee ») il y a quelques minutes → 409 PAIEMENT_EN_COURS, rien n’est écrit', async () => {
    const { id, charge } = await factureRepartie();
    await transactionSurCharge(charge, 'annulee', '10 minutes');

    const res = await api().post(`${FC}/${id}/annuler`).set(proprio.h).send({ reason: 'Facture contestée' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAIEMENT_EN_COURS');
    const apres = await etat(id);
    expect(apres.facture).toBe('repartie');
    expect(apres.charges).toEqual([charge.status]);
    expect(apres.audit).toBe(0);
  });

  test('transaction annulée il y a 23 h 59 → encore refusée ; il y a plus de 24 h → annulation acceptée', async () => {
    const recente = await factureRepartie();
    await transactionSurCharge(recente.charge, 'annulee', '23 hours 59 minutes');
    expect((await api().post(`${FC}/${recente.id}/annuler`).set(proprio.h).send({ reason: 'Erreur de saisie' })).status).toBe(409);

    const ancienne = await factureRepartie();
    await transactionSurCharge(ancienne.charge, 'annulee', '25 hours');
    const res = await api().post(`${FC}/${ancienne.id}/annuler`).set(proprio.h).send({ reason: 'Erreur de saisie' });
    expect(res.status).toBe(200);
    expect(res.body.data.invoice.status).toBe('annulee');
    expect(await etat(ancienne.id)).toEqual({ facture: 'annulee', charges: ['annule'], audit: 1 });
  });

  test.each([['initiee'], ['en_attente']])('transaction « %s » (même ancienne) → 409 PAIEMENT_EN_COURS', async (statut) => {
    const { id, charge } = await factureRepartie();
    await transactionSurCharge(charge, statut, '3 days');
    const res = await api().post(`${FC}/${id}/annuler`).set(proprio.h).send({ reason: 'Erreur de saisie' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAIEMENT_EN_COURS');
    expect((await etat(id)).facture).toBe('repartie');
  });

  test('transaction échouée récente : aucun encaissement possible → annulation acceptée', async () => {
    const { id, charge } = await factureRepartie();
    await transactionSurCharge(charge, 'echouee', '5 minutes');
    expect((await api().post(`${FC}/${id}/annuler`).set(proprio.h).send({ reason: 'Erreur de saisie' })).status).toBe(200);
  });
});
