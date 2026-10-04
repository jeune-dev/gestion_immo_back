'use strict';

const fs = require('fs');
const path = require('path');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, creerLocataire, bailActif, echeancesDu,
  pngTest, compter, fermer, sequelize,
} = require('../../setup/helpers.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const storage = require('../../../infrastructure/storage.service.js');
const { prochainNumero } = require('../../../utils/compteur.js');
const { journaliser } = require('../../../modules/audit/service/audit.service.js');

/**
 * TRANSACTIONS : une opération à plusieurs écritures est tout-ou-rien.
 *
 *   succès : A → B → C → COMMIT        (tout est écrit)
 *   échec  : A → B → ERREUR → ROLLBACK (RIEN n'est écrit : ni ligne partielle,
 *            ni journal d'audit mensonger, ni fichier orphelin, ni numéro brûlé)
 */
describe('Transactions et cohérence après erreur', () => {
  afterAll(fermer);

  test('activation de bail : succès = statut + appartement occupé + échéances + caution + audit, dans le même COMMIT', async () => {
    const p = await nouveauProprietaire();
    const { lease, apartment } = await bailActif(p);
    const [[l]] = await sequelize.query('SELECT status FROM leases WHERE id = :id', { replacements: { id: lease.id } });
    const [[a]] = await sequelize.query('SELECT status FROM apartments WHERE id = :id', { replacements: { id: apartment.id } });
    expect(l.status).toBe('actif');
    expect(a.status).toBe('occupe');
    expect(await compter('rent_schedules', 'lease_id = :id', { id: lease.id })).toBeGreaterThan(0);
    expect(await compter('deposits', 'lease_id = :id', { id: lease.id })).toBe(1);
    expect(await compter('audit_logs', "action = 'bail.changement_statut' AND entity_id = :id", { id: lease.id })).toBe(1);
  });

  test('activation de bail refusée (état des lieux requis) : ROLLBACK complet — aucune échéance, aucune caution, aucun statut changé', async () => {
    const p = await nouveauProprietaire();
    const building = await creerImmeuble(p);
    const apartment = await creerAppartement(p, building.id);
    const tenant = await creerLocataire(p);
    const bail = (await api().post('/api/v1/baux').set(p.h).send({ apartment_id: apartment.id, tenant_id: tenant.id, start_date: '2026-10-01', deposit_amount: 1000 })).body.data.lease;
    const res = await api().post(`/api/v1/baux/${bail.id}/activer`).set(p.h);
    expect(res.status).toBe(409);
    expect(await compter('rent_schedules', 'lease_id = :id', { id: bail.id })).toBe(0);
    expect(await compter('deposits', 'lease_id = :id', { id: bail.id })).toBe(0);
    expect(await compter('audit_logs', "action = 'bail.changement_statut' AND entity_id = :id", { id: bail.id })).toBe(0);
    const [[a]] = await sequelize.query('SELECT status FROM apartments WHERE id = :id', { replacements: { id: apartment.id } });
    expect(a.status).toBe('disponible');
  });

  test('paiement refusé APRÈS l’insertion du paiement (montant supérieur au dû) : aucune ligne partielle dans 5 tables', async () => {
    const p = await nouveauProprietaire();
    const { lease } = await bailActif(p, { bail: { end_date: '2026-10-31' } });
    const avant = await Promise.all(['rent_payments', 'payment_allocations', 'cash_movements', 'receipts', 'audit_logs']
      .map((t) => compter(t, t === 'audit_logs' ? 'owner_id = :o' : 'owner_id = :o', { o: p.ownerId })));
    const res = await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, amount: 99999999, paid_on: '2026-09-05' });
    expect(res.status).toBe(422);
    const apres = await Promise.all(['rent_payments', 'payment_allocations', 'cash_movements', 'receipts', 'audit_logs']
      .map((t) => compter(t, 'owner_id = :o', { o: p.ownerId })));
    expect(apres).toEqual(avant);
    // Et le compteur de références n'a pas été consommé : le prochain paiement prend le numéro 001.
    const ok = await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, amount: 1000, paid_on: '2026-09-05' });
    expect(ok.body.data.payment.reference).toBe('PAY-20260905-001');
  });

  test('fichier stocké puis transaction annulée : le fichier est SUPPRIMÉ du stockage (pas d’orphelin)', async () => {
    const png = await pngTest();
    let cle;
    await expect(transactionAvecFichiers(async (t) => {
      cle = await storage.enregistrer(png, 'owners/test/rollback', 'png', 'image/png');
      t.clesStockees.push(cle);
      expect(await storage.ouvrir(cle)).not.toBeNull();
      throw new Error('échec métier simulé après le stockage');
    })).rejects.toThrow('échec métier simulé');
    expect(await storage.ouvrir(cle)).toBeNull();
    expect(fs.existsSync(path.join(storage.UPLOAD_DIR, ...cle.split('/')))).toBe(false);
  });

  test('téléversement refusé par une règle métier : ni ligne documents, ni fichier sur le disque', async () => {
    const p = await nouveauProprietaire();
    const { lease } = await bailActif(p);
    const [[d]] = await sequelize.query('SELECT id FROM deposits WHERE lease_id = :l', { replacements: { l: lease.id } });
    const fichiersAvant = compterFichiers(storage.UPLOAD_DIR);
    const docsAvant = await compter('documents', 'owner_id = :o', { o: p.ownerId });
    // Justificatif accepté puis retenue refusée (bail encore actif) : la retenue
    // n'écrit rien ; le justificatif, opération distincte, reste valide.
    const j = await api().post(`/api/v1/cautions/${d.id}/justificatifs`).set(p.h).attach('fichier', await pngTest(), 'j.png');
    expect(j.status).toBe(201);
    const r = await api().post(`/api/v1/cautions/${d.id}/retenues`).set(p.h)
      .send({ amount: 1000, reason: 'degradation', description: 'Porte', justification_document_ids: [j.body.data.document.id] });
    expect(r.status).toBe(409);
    expect(await compter('deposit_transactions', 'deposit_id = :d', { d: d.id })).toBe(0);
    // Faux PNG (texte renommé) : refusé AVANT toute écriture.
    const faux = await api().post(`/api/v1/cautions/${d.id}/justificatifs`).set(p.h).attach('fichier', Buffer.from('ceci n’est pas une image'), 'faux.png');
    expect(faux.status).toBe(400);
    expect(await compter('documents', 'owner_id = :o', { o: p.ownerId })).toBe(docsAvant + 1);
    expect(compterFichiers(storage.UPLOAD_DIR)).toBe(fichiersAvant + 2); // original + miniature du seul justificatif accepté
  });

  test('le journal d’audit suit la transaction : écrit au COMMIT, absent après ROLLBACK', async () => {
    const p = await nouveauProprietaire();
    await expect(sequelize.transaction(async (t) => {
      await journaliser({ action: 'test.rollback', ownerId: p.ownerId, entityType: 'test', entityId: 'x' }, t);
      throw new Error('annulation');
    })).rejects.toThrow('annulation');
    expect(await compter('audit_logs', "action = 'test.rollback' AND owner_id = :o", { o: p.ownerId })).toBe(0);
    await sequelize.transaction((t) => journaliser({ action: 'test.commit', ownerId: p.ownerId, entityType: 'test', entityId: 'x' }, t));
    expect(await compter('audit_logs', "action = 'test.commit' AND owner_id = :o", { o: p.ownerId })).toBe(1);
  });

  test('numérotation : un numéro pris dans une transaction annulée est rendu ; 30 prises simultanées sont toutes distinctes', async () => {
    const portee = `test:${Date.now()}`;
    await expect(sequelize.transaction(async (t) => {
      expect(await prochainNumero(portee, t)).toBe(1);
      throw new Error('annulation');
    })).rejects.toThrow();
    expect(await sequelize.transaction((t) => prochainNumero(portee, t))).toBe(1);
    const numeros = await Promise.all(Array.from({ length: 30 }, () => sequelize.transaction((t) => prochainNumero(portee, t))));
    expect(new Set(numeros).size).toBe(30);
    expect(Math.max(...numeros)).toBe(31);
  });

  test('remboursement : échéance rouverte, quittance annulée, sortie de caisse et paiement « remboursé » dans le même COMMIT', async () => {
    const p = await nouveauProprietaire();
    const { lease } = await bailActif(p);
    const [e] = await echeancesDu(p, lease.id);
    const pay = (await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, rent_schedule_id: e.id, amount: e.amount_due, paid_on: '2026-09-05' })).body.data.payment;
    expect((await api().post(`/api/v1/paiements/${pay.id}/rembourser`).set(p.h).send({ reason: 'Erreur' })).status).toBe(200);
    const [[etat]] = await sequelize.query(`
      SELECT (SELECT status FROM rent_payments WHERE id = :p) AS paiement,
             (SELECT amount_paid FROM rent_schedules WHERE id = :e)::int AS paye,
             (SELECT count(*) FROM receipts WHERE rent_schedule_id = :e AND cancelled_at IS NULL)::int AS quittances_valides,
             (SELECT count(*) FROM payment_allocations WHERE rent_payment_id = :p AND reversed_at IS NULL)::int AS allocations_actives,
             (SELECT count(*) FROM cash_movements WHERE source_id = :p AND category = 'remboursement')::int AS remboursements`,
    { replacements: { p: pay.id, e: e.id } });
    expect(etat).toEqual({ paiement: 'rembourse', paye: 0, quittances_valides: 0, allocations_actives: 0, remboursements: 1 });
  });
});

function compterFichiers(dossier) {
  if (!fs.existsSync(dossier)) return 0;
  let n = 0;
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    n += entree.isDirectory() ? compterFichiers(path.join(dossier, entree.name)) : 1;
  }
  return n;
}
