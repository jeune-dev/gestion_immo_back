'use strict';

const crypto = require('crypto');
const {
  api, nouveauProprietaire, bailActif, creerLocataire, fermer, sequelize, compter, pngTest,
} = require('../../../setup/helpers.js');
const { aujourdhui, ajouterJours } = require('../../../../utils/dates.js');
const { analyser, appliquer } = require('../../../../database/rattrapageCoherence.js');

/**
 * Reprise des données antérieures aux règles de cohérence, et dates de fin de bail.
 * L'ancien état est reconstitué en retirant les écritures que l'API crée désormais.
 */

const jour = aujourdhui();
const debut = ajouterJours(jour, -60);
const FC = '/api/v1/factures-communes';

const sql = (texte, replacements) => sequelize.query(texte, { replacements });

const nouveauBail = async (bail = {}) => {
  const p = await nouveauProprietaire();
  return { p, ...(await bailActif(p, { bail: { start_date: debut, ...bail } })) };
};

const factureRepartie = async (p, building, surcharges = {}) => {
  const f = await api().post(FC).set(p.h).send({
    building_id: building.id, charge_type: 'eau', supplier: 'SDE', period_start: debut, period_end: jour,
    amount: 40000, allocation_method: 'egale', recharge_to_tenants: false, ...surcharges,
  });
  expect(f.status).toBe(201);
  expect((await api().post(`${FC}/${f.body.data.invoice.id}/repartir`).set(p.h).send({})).status).toBe(200);
  return f.body.data.invoice;
};

/** Facture répartie avant que la répartition ne crée sa dépense. */
const ancienneFacture = async (p, building, surcharges) => {
  const f = await factureRepartie(p, building, surcharges);
  await sql("DELETE FROM cash_movements WHERE source_type = 'expense' AND source_id IN (SELECT id FROM expenses WHERE charge_invoice_id = :f)", { f: f.id });
  await sql('DELETE FROM expenses WHERE charge_invoice_id = :f', { f: f.id });
  return f;
};

const depenseManuelle = async (p, building) => {
  const [[categorie]] = await sequelize.query("SELECT id FROM expense_categories WHERE code = 'facture_eau' AND owner_id IS NULL");
  const r = await api().post('/api/v1/depenses').set(p.h).send({
    building_id: building.id, category_id: categorie.id, amount: 40000, method: 'especes', spent_on: jour,
  });
  expect(r.status).toBe(201);
  return r.body.data.expense;
};

/** Bail terminé, caution versée, retenue d'avant la sortie de caisse automatique. */
async function ancienneRetenue(montant = 50000, raison = 'degradation') {
  const x = await nouveauBail();
  const caution = (await api().get(`/api/v1/cautions?lease_id=${x.lease.id}`).set(x.p.h)).body.data.items[0];
  await api().post(`/api/v1/cautions/${caution.id}/versements`).set(x.p.h).set('Idempotency-Key', crypto.randomUUID())
    .send({ amount: caution.amount_expected, occurred_on: debut, method: 'especes' });
  expect((await api().post(`/api/v1/baux/${x.lease.id}/terminer`).set(x.p.h).send({ ended_on: jour })).status).toBe(200);
  const piece = await api().post(`/api/v1/cautions/${caution.id}/justificatifs`).set(x.p.h).attach('fichier', await pngTest(), 'piece.png');
  const r = await api().post(`/api/v1/cautions/${caution.id}/retenues`).set(x.p.h).set('Idempotency-Key', crypto.randomUUID())
    .send({ amount: montant, reason: 'degradation', description: 'Retenue de fin de bail', justification_document_ids: [piece.body.data.document.id] });
  expect(r.status).toBe(201);
  const trId = r.body.data.transaction.id;
  await sql("DELETE FROM cash_movements WHERE source_type = 'deposit_transaction' AND source_id = :t", { t: trId });
  await sql('UPDATE deposit_transactions SET reason = :raison WHERE id = :t', { t: trId, raison });
  return { ...x, trId };
}

const resteDu = async (leaseId) => {
  const [[l]] = await sequelize.query(
    "SELECT COALESCE(sum(amount_due - amount_paid), 0)::bigint AS reste FROM rent_schedules WHERE lease_id = :l AND status IN ('a_payer', 'partiellement_paye', 'en_retard')",
    { replacements: { l: leaseId } }
  );
  return Number(l.reste);
};

afterAll(fermer);

describe('Rattrapage des données', () => {
  test('analyse sans écriture, puis dépense et caisse datées de la répartition, une seule fois', async () => {
    const { p, building } = await nouveauBail();
    const f = await ancienneFacture(p, building);
    await sql("UPDATE charge_invoices SET allocated_at = :d WHERE id = :f", { d: `${debut}T12:00:00Z`, f: f.id });

    const a = await analyser({ ownerId: p.ownerId });
    expect(a.factures_a_creer.map((l) => l.id)).toEqual([f.id]);
    expect(await compter('expenses', 'charge_invoice_id = :f', { f: f.id })).toBe(0);

    expect(await appliquer({ ownerId: p.ownerId })).toMatchObject({ depenses_creees: 1, erreurs: [] });
    const [[e]] = await sequelize.query("SELECT id, amount, spent_on, status FROM expenses WHERE charge_invoice_id = :f", { replacements: { f: f.id } });
    expect(e).toMatchObject({ amount: 40000, spent_on: debut, status: 'valide' });
    expect(await compter('cash_movements', "source_type = 'expense' AND source_id = :e AND direction = 'sortie'", { e: e.id })).toBe(1);

    expect(await appliquer({ ownerId: p.ownerId })).toMatchObject({ depenses_creees: 0, depenses_rattachees: 0 });
    expect(await compter('expenses', 'charge_invoice_id = :f', { f: f.id })).toBe(1);
  });

  test('une seule dépense manuelle correspondante : rattachée, pas de second coût', async () => {
    const { p, building } = await nouveauBail();
    const f = await ancienneFacture(p, building);
    const e = await depenseManuelle(p, building);

    expect(await appliquer({ ownerId: p.ownerId })).toMatchObject({ depenses_rattachees: 1, depenses_creees: 0 });
    const [[lien]] = await sequelize.query('SELECT charge_invoice_id FROM expenses WHERE id = :e', { replacements: { e: e.id } });
    expect(lien.charge_invoice_id).toBe(f.id);
    expect(await compter('expenses', 'owner_id = :o', { o: p.ownerId })).toBe(1);
  });

  test('plusieurs dépenses possibles : signalé, rien de modifié', async () => {
    const { p, building } = await nouveauBail();
    const f = await ancienneFacture(p, building);
    await depenseManuelle(p, building);
    await depenseManuelle(p, building);

    expect((await analyser({ ownerId: p.ownerId })).factures_ambigues.map((l) => l.id)).toEqual([f.id]);
    expect(await appliquer({ ownerId: p.ownerId })).toMatchObject({ depenses_rattachees: 0, depenses_creees: 0 });
    expect(await compter('expenses', 'charge_invoice_id = :f', { f: f.id })).toBe(0);
  });

  test('factures en double : signalées, aucune dépense créée', async () => {
    const { p, building } = await nouveauBail();
    const a = await ancienneFacture(p, building, { invoice_number: 'A' });
    const b = await ancienneFacture(p, building, { invoice_number: 'B' });
    await sql('UPDATE charge_invoices SET invoice_number = NULL WHERE id IN (:ids)', { ids: [a.id, b.id] });

    const analyse = await analyser({ ownerId: p.ownerId });
    expect(analyse.doublons).toHaveLength(1);
    expect(analyse.doublons[0].ids.sort()).toEqual([a.id, b.id].sort());
    expect(analyse.factures_a_creer).toHaveLength(0);
    expect(await appliquer({ ownerId: p.ownerId })).toMatchObject({ depenses_creees: 0 });
    expect(await compter('charge_invoices', "id IN (:ids) AND status = 'repartie'", { ids: [a.id, b.id] })).toBe(2);
  });

  test('retenue sans sortie : sortie de caisse du montant retenu ; retenue annulée ignorée', async () => {
    const x = await ancienneRetenue(50000);
    expect(await appliquer({ ownerId: x.p.ownerId })).toMatchObject({ sorties_caisse: 1, erreurs: [] });
    const [[m]] = await sequelize.query("SELECT amount, direction, is_deposit FROM cash_movements WHERE source_type = 'deposit_transaction' AND source_id = :t", { replacements: { t: x.trId } });
    expect(m).toMatchObject({ amount: 50000, direction: 'sortie', is_deposit: true });
    expect(await appliquer({ ownerId: x.p.ownerId })).toMatchObject({ sorties_caisse: 0 });

    const y = await ancienneRetenue(50000);
    await sql("UPDATE deposit_transactions SET contest_status = 'annulee' WHERE id = :t", { t: y.trId });
    expect((await analyser({ ownerId: y.p.ownerId })).retenues_sans_sortie).toHaveLength(0);
  });

  test('imputation des anciennes retenues : seulement sur demande, plafonnée au reste dû', async () => {
    const x = await ancienneRetenue(50000, 'loyer_impaye');
    const avant = await resteDu(x.lease.id);
    expect(avant).toBeGreaterThan(50000);

    await appliquer({ ownerId: x.p.ownerId });
    expect(await resteDu(x.lease.id)).toBe(avant);

    expect(await appliquer({ ownerId: x.p.ownerId, imputerRetenues: true })).toMatchObject({ retenues_imputees: 1, erreurs: [] });
    expect(await resteDu(x.lease.id)).toBe(avant - 50000);
    const [[tr]] = await sequelize.query('SELECT rent_payment_id FROM deposit_transactions WHERE id = :t', { replacements: { t: x.trId } });
    expect(tr.rent_payment_id).toBeTruthy();

    expect(await appliquer({ ownerId: x.p.ownerId, imputerRetenues: true })).toMatchObject({ retenues_imputees: 0 });
    expect(await resteDu(x.lease.id)).toBe(avant - 50000);
  });

  test('provision non déduite : signalée, jamais recalculée', async () => {
    const { p, building } = await nouveauBail({ charges_amount: 10000 });
    const f = await factureRepartie(p, building, { recharge_to_tenants: true });
    await sql('UPDATE charge_allocations SET provision_deducted = 0 WHERE charge_invoice_id = :f', { f: f.id });

    expect((await analyser({ ownerId: p.ownerId })).provisions_non_deduites.map((l) => l.id)).toEqual([f.id]);
    await appliquer({ ownerId: p.ownerId });
    expect(await compter('charge_allocations', 'charge_invoice_id = :f AND provision_deducted > 0', { f: f.id })).toBe(0);
  });
});

describe('Dates de fin de bail', () => {
  const brouillon = async (x, corps) => {
    const tenant = await creerLocataire(x.p);
    const r = await api().post('/api/v1/baux').set(x.p.h).send({
      apartment_id: x.lease.apartment_id, tenant_id: tenant.id, rent_amount: 100000, periodicity: 'mensuel', due_day: 5, ...corps,
    });
    expect(r.status).toBe(201);
    return r.body.data.lease;
  };
  const activer = (x, id) => api().post(`/api/v1/baux/${id}/activer`).set(x.p.h).send({});

  test('sortie dans le futur refusée : bail actif, appartement occupé', async () => {
    const x = await nouveauBail();
    const r = await api().post(`/api/v1/baux/${x.lease.id}/terminer`).set(x.p.h).send({ ended_on: ajouterJours(jour, 1) });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('DATE_SORTIE_FUTURE');
    expect(await compter('leases', "id = :l AND status = 'actif'", { l: x.lease.id })).toBe(1);
    expect(await compter('apartments', "id = :a AND status = 'occupe'", { a: x.lease.apartment_id })).toBe(1);

    expect((await api().post(`/api/v1/baux/${x.lease.id}/terminer`).set(x.p.h).send({ ended_on: jour })).status).toBe(200);
  });

  test('nouveau bail : chevauchement refusé, entrée le jour de la sortie acceptée', async () => {
    const x = await nouveauBail();
    expect((await api().post(`/api/v1/baux/${x.lease.id}/terminer`).set(x.p.h).send({ ended_on: jour })).status).toBe(200);

    const chevauche = await brouillon(x, { start_date: ajouterJours(jour, -10) });
    const refus = await activer(x, chevauche.id);
    expect(refus.status).toBe(409);
    expect(refus.body.code).toBe('BAUX_CHEVAUCHES');

    const suivant = await brouillon(x, { start_date: jour });
    expect((await activer(x, suivant.id)).status).toBe(200);
  });

  test('bail historique entièrement antérieur au bail terminé : accepté', async () => {
    const x = await nouveauBail();
    expect((await api().post(`/api/v1/baux/${x.lease.id}/terminer`).set(x.p.h).send({ ended_on: jour })).status).toBe(200);
    const ancien = await brouillon(x, { start_date: ajouterJours(debut, -200), end_date: ajouterJours(debut, -10) });
    expect((await activer(x, ancien.id)).status).toBe(200);
  });
});
