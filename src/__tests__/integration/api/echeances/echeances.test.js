'use strict';

const {
  api, nouveauProprietaire, bailActif, activerLocataire, proprietaireEtLocataire, fermer, sequelize, compter, payerEspeces,
} = require('../../../setup/helpers.js');
const {
  UUID_ABSENT, simulerFournisseurs, preparerPaydunya, initier, ipn, enFormulaire, echeancesDu, ligne,
  verifierAuthentification, verifierCompteDesactive, restreindrePermissions,
} = require('../paiements/outils.paiements.js');

/**
 * Échéances de loyer (§ 10 génération, § 11 statuts, § 41 « PAYÉ seulement
 * avec un paiement valide ») :
 *   GET /echeances · GET /echeances/:id · POST /echeances/:id/annuler
 *   GET /locataire/echeances · GET /locataire/echeances/:id
 */

const annuler = (p, id, corps = { reason: 'Geste commercial' }) => api().post(`/api/v1/echeances/${id}/annuler`).set(p.h).send(corps);

describe('Échéances', () => {
  let fournisseurs;
  beforeAll(() => { fournisseurs = simulerFournisseurs(); });
  afterAll(async () => {
    fournisseurs.restaurer();
    await fermer();
  });

  describe('authentification et autorisations', () => {
    const proprio = [
      ['GET', '/api/v1/echeances', null],
      ['GET', `/api/v1/echeances/${UUID_ABSENT}`, null],
      ['POST', `/api/v1/echeances/${UUID_ABSENT}/annuler`, { reason: 'Geste commercial' }],
    ];
    const locataire = [
      ['GET', '/api/v1/locataire/echeances', null],
      ['GET', `/api/v1/locataire/echeances/${UUID_ABSENT}`, null],
    ];

    test.each(proprio)('%s %s : 401 sans jeton valide', async (m, url, c) => {
      await verifierAuthentification(m, url, await nouveauProprietaire(), c);
    });

    test.each(locataire)('%s %s : 401 sans jeton valide', async (m, url, c) => {
      const { locataire: loc } = await proprietaireEtLocataire();
      await verifierAuthentification(m, url, loc, c);
    });

    test('comptes désactivés → 403 ; rôles croisés → 403', async () => {
      const { proprio: p, locataire: loc } = await proprietaireEtLocataire();
      for (const [m, url, c] of proprio) {
        const r = api()[m.toLowerCase()](url).set(loc.h);
        expect((m === 'GET' ? await r : await r.send(c)).status).toBe(403);
      }
      for (const [, url] of locataire) expect((await api().get(url).set(p.h)).status).toBe(403);
      await verifierCompteDesactive(proprio, p);
      await verifierCompteDesactive(locataire, loc);
    });

    test('permissions : « loyers.lire » pour lire, « loyers.ecrire » pour annuler', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      await restreindrePermissions(p, ['loyers.lire']);
      expect((await api().get('/api/v1/echeances').set(p.h)).status).toBe(200);
      const refus = await annuler(p, sept.id);
      expect(refus.status).toBe(403);
      expect(refus.body.error.code).toBe('PERMISSION_REFUSEE');
      await restreindrePermissions(p, []);
      expect((await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).status).toBe(403);
    });
  });

  describe('GET /echeances', () => {
    test('§ 10 génération : 12 mois d’horizon, montants, libellés, échéance au jour convenu ; § 11 statuts initiaux', async () => {
      const p = await nouveauProprietaire();
      const { lease, tenant, apartment, building } = await bailActif(p);
      const res = await api().get(`/api/v1/echeances?lease_id=${lease.id}&tri=due_date&limit=100`).set(p.h);
      expect(res.status).toBe(200);
      const items = res.body.data.items;
      expect(items.length).toBe(res.body.data.pagination.total);
      expect(items.length).toBeGreaterThanOrEqual(12);
      expect(items[0]).toMatchObject({
        period_start: '2026-09-01', period_end: '2026-09-30', due_date: '2026-09-05', rent_amount: 350000, charges_amount: 0,
        amount_due: 350000, amount_paid: 0, label: 'Loyer septembre 2026', status: 'en_retard',
        tenant: { id: tenant.id }, apartment: { id: apartment.id, building: { id: building.id } },
      });
      expect(items[1]).toMatchObject({ period_start: '2026-10-01', due_date: '2026-10-05' });
      expect(['a_venir', 'a_payer']).toContain(items[1].status);
      expect(items.every((e) => e.amount_due === 350000)).toBe(true);
    });

    test('pagination (défaut 30) : pages, au-delà, plafond 100, total exact', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const tout = await api().get('/api/v1/echeances').set(p.h);
      expect(tout.body.data.pagination.limit).toBe(30);
      const total = tout.body.data.pagination.total;
      const p1 = await api().get('/api/v1/echeances?limit=5&page=1').set(p.h);
      const p2 = await api().get('/api/v1/echeances?limit=5&page=2').set(p.h);
      expect(p1.body.data.pagination).toEqual({ page: 1, limit: 5, total, totalPages: Math.ceil(total / 5) });
      expect(new Set([...p1.body.data.items, ...p2.body.data.items].map((e) => e.id)).size).toBe(10);
      expect((await api().get('/api/v1/echeances?limit=5&page=99').set(p.h)).body.data.items).toEqual([]);
      expect((await api().get('/api/v1/echeances?limit=1000').set(p.h)).body.data.pagination.limit).toBe(100);
      expect(lease.id).toBeDefined();
    });

    test('filtres : bail, locataire, appartement, immeuble, statut, impayés, période ; tris', async () => {
      const p = await nouveauProprietaire();
      const a = await bailActif(p);
      const b = await bailActif(p, { appartement: { rent_amount: 100000 } });
      const [septA, octA] = await echeancesDu(p, a.lease.id);
      await payerEspeces(p, a.lease.id, 350000, { scheduleId: septA.id });
      await payerEspeces(p, a.lease.id, 100000, { scheduleId: octA.id });
      const q = async (qs) => (await api().get(`/api/v1/echeances?limit=100&${qs}`).set(p.h)).body.data.items;
      expect((await q(`lease_id=${b.lease.id}`)).every((e) => e.lease_id === b.lease.id)).toBe(true);
      expect((await q(`tenant_id=${a.tenant.id}`)).every((e) => e.tenant_id === a.tenant.id)).toBe(true);
      expect((await q(`apartment_id=${b.apartment.id}`)).every((e) => e.apartment_id === b.apartment.id)).toBe(true);
      expect((await q(`building_id=${a.building.id}`)).every((e) => e.lease_id === a.lease.id)).toBe(true);
      expect((await q('status=paye')).map((e) => e.id)).toEqual([septA.id]);
      expect((await q('status=partiellement_paye')).map((e) => e.id)).toEqual([octA.id]);
      // § 48 « Qui n'a pas payé ? » : en retard ou partiellement payées.
      const impayes = await q('impayes=true');
      expect(impayes.map((e) => e.id).sort()).toEqual([octA.id, (await echeancesDu(p, b.lease.id))[0].id].sort());
      expect((await q('du=2026-10-01&au=2026-10-31')).every((e) => e.due_date >= '2026-10-01' && e.due_date <= '2026-10-31')).toBe(true);
      expect((await q('du=2026-10-01&au=2026-10-31'))).toHaveLength(2);
      const parMontant = await q('tri=amount_due');
      expect(parMontant[0].amount_due).toBe(100000);
      expect((await q('tri=-amount_due'))[0].amount_due).toBe(350000);
      const parDate = await q('tri=-due_date');
      expect(parDate[0].due_date >= parDate[parDate.length - 1].due_date).toBe(true);
    });

    test.each([
      'page=0', 'page=-1', 'limit=0', 'limit=abc', 'tri=label', 'tri=due_date;DROP', 'status=impaye', 'status=%27%20OR%201=1--',
      'impayes=oui', 'lease_id=abc', 'building_id=1', 'du=2026-02-31x', 'au=31/12/2026',
    ])('paramètre invalide %s → 422', async (qs) => {
      const p = await nouveauProprietaire();
      const res = await api().get(`/api/v1/echeances?${qs}`).set(p.h);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('DONNEES_INVALIDES');
    });

    test('liste vide pour un nouveau propriétaire ; isolation entre propriétaires', async () => {
      const a = await nouveauProprietaire();
      const b = await nouveauProprietaire();
      expect((await api().get('/api/v1/echeances').set(b.h)).body.data).toEqual({ items: [], pagination: { page: 1, limit: 30, total: 0, totalPages: 1 } });
      const { lease } = await bailActif(a);
      expect((await api().get(`/api/v1/echeances?lease_id=${lease.id}`).set(b.h)).body.data.items).toEqual([]);
    });
  });

  describe('GET /echeances/:id', () => {
    test('détail : imputations actives, paiement, quittance valide ; après remboursement : plus rien', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      const r = await payerEspeces(p, lease.id, 350000, { scheduleId: sept.id });
      const d = (await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule;
      expect(d).toMatchObject({ id: sept.id, status: 'paye', amount_paid: 350000, receipt: { id: r.receipts[0].id, number: r.receipts[0].number } });
      expect(d.allocations).toEqual([expect.objectContaining({ amount: 350000, payment: expect.objectContaining({ id: r.payment.id, reference: r.payment.reference, method: 'especes' }) })]);
      await api().post(`/api/v1/paiements/${r.payment.id}/rembourser`).set(p.h).send({ reason: 'Erreur' });
      const apres = (await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule;
      expect(apres).toMatchObject({ amount_paid: 0, receipt: null, allocations: [] });
      expect(apres.status).not.toBe('paye');
    });

    test('introuvable → 404 ; UUID invalide → 422 ; autre propriétaire → 403', async () => {
      const a = await nouveauProprietaire();
      const b = await nouveauProprietaire();
      const { lease } = await bailActif(a);
      const [sept] = await echeancesDu(a, lease.id);
      expect((await api().get(`/api/v1/echeances/${UUID_ABSENT}`).set(a.h)).status).toBe(404);
      expect((await api().get('/api/v1/echeances/42').set(a.h)).status).toBe(422);
      const res = await api().get(`/api/v1/echeances/${sept.id}`).set(b.h);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCES_AUTRE_PROPRIETAIRE');
    });
  });

  describe('POST /echeances/:id/annuler (§ 11 « Annulé »)', () => {
    test('nominal : statut annulé, motif, journal ; l’échéance n’est plus proposée au locataire', async () => {
      const { proprio: p, locataire: loc, lease } = await proprietaireEtLocataire();
      const [sept] = await echeancesDu(p, lease.id);
      const res = await annuler(p, sept.id, { reason: 'Remise exceptionnelle' });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Échéance annulée');
      expect(res.body.data.schedule).toMatchObject({ id: sept.id, status: 'annule', cancel_reason: 'Remise exceptionnelle' });
      expect(res.body.data.schedule.cancelled_at).not.toBeNull();
      const audit = await ligne("SELECT details FROM audit_logs WHERE action = 'echeance.changement_statut' AND entity_id = :id", { id: sept.id });
      expect(audit.details).toMatchObject({ apres: 'annule', motif: 'Remise exceptionnelle', montant: 350000 });
      const ids = (await api().get('/api/v1/locataire/echeances?limit=100').set(loc.h)).body.data.items.map((e) => e.id);
      expect(ids).not.toContain(sept.id);
    });

    test.each([['motif absent', {}], ['motif trop court', { reason: 'ok' }], ['motif trop long', { reason: 'x'.repeat(501) }], ['motif non texte', { reason: ['a', 'b'] }]])('validation — %s → 422', async (_l, corps) => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      expect((await annuler(p, sept.id, corps)).status).toBe(422);
      expect((await ligne('SELECT status FROM rent_schedules WHERE id = :id', { id: sept.id })).status).not.toBe('annule');
    });

    test('déjà annulée → 409 DEJA_ANNULE ; partiellement encaissée → 409 ECHEANCE_ENCAISSEE ; autre propriétaire → 403 ; introuvable → 404', async () => {
      const a = await nouveauProprietaire();
      const b = await nouveauProprietaire();
      const { lease } = await bailActif(a);
      const [sept, oct] = await echeancesDu(a, lease.id);
      expect((await annuler(a, sept.id)).status).toBe(200);
      const deja = await annuler(a, sept.id);
      expect(deja.status).toBe(409);
      expect(deja.body.error.code).toBe('DEJA_ANNULE');
      await payerEspeces(a, lease.id, 1000, { scheduleId: oct.id });
      const encaissee = await annuler(a, oct.id);
      expect(encaissee.status).toBe(409);
      expect(encaissee.body.error.code).toBe('ECHEANCE_ENCAISSEE');
      expect((await annuler(b, oct.id)).status).toBe(403);
      expect((await annuler(a, UUID_ABSENT)).status).toBe(404);
    });

    test('demande mobile money en cours → 409 PAIEMENT_EN_COURS ; une fois confirmée → 409 ECHEANCE_ENCAISSEE', async () => {
      const { p, loc, echeances, providerId } = await preparerPaydunya();
      const init = await initier(loc, { rent_schedule_id: echeances[0].id, wallet: 'wave' });
      expect((await annuler(p, echeances[0].id)).body.error.code).toBe('PAIEMENT_EN_COURS');
      await api().post(`/api/v1/webhooks/paydunya/${providerId}`).type('form').send(enFormulaire(ipn(init.body.data.transaction.reference, 350000)));
      expect((await annuler(p, echeances[0].id)).body.error.code).toBe('ECHEANCE_ENCAISSEE');
    });

    test('concurrence : annulation et encaissement simultanés → jamais les deux (échéance annulée ET payée impossible)', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      const [a, b] = await Promise.all([
        annuler(p, sept.id),
        api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, rent_schedule_id: sept.id, amount: 350000, paid_on: '2026-09-05' }),
      ]);
      const e = await ligne('SELECT status, amount_paid FROM rent_schedules WHERE id = :id', { id: sept.id });
      if (a.status === 200) {
        expect(b.status).toBe(409);
        expect(e).toEqual({ status: 'annule', amount_paid: 0 });
        expect(await compter('rent_payments', 'lease_id = :l', { l: lease.id })).toBe(0);
      } else {
        expect(a.status).toBe(409);
        expect(b.status).toBe(201);
        expect(e).toEqual({ status: 'paye', amount_paid: 350000 });
      }
    });

    test('concurrence : double annulation simultanée → une seule réussit, un seul journal', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      const reponses = await Promise.all([annuler(p, sept.id), annuler(p, sept.id), annuler(p, sept.id)]);
      expect(reponses.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await compter('audit_logs', "action = 'echeance.changement_statut' AND entity_id = :id", { id: sept.id })).toBe(1);
    });
  });

  describe('§ 41 un loyer n’est PAYÉ que s’il existe un paiement valide', () => {
    test('la base refuse « paye » sans montant soldé ; le client ne peut pas écrire amount_paid', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      await expect(sequelize.query("UPDATE rent_schedules SET status = 'paye' WHERE id = :id", { replacements: { id: sept.id } })).rejects.toThrow();
      const res = await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, rent_schedule_id: sept.id, amount: 1000, paid_on: '2026-09-05', amount_paid: 350000, status: 'paye' });
      expect(res.status).toBe(201);
      expect(await ligne('SELECT status, amount_paid FROM rent_schedules WHERE id = :id', { id: sept.id })).toEqual({ status: 'en_retard', amount_paid: 1000 });
    });

    test('§ 11 transitions : à payer/en retard → partiellement payé → payé ; remboursement → rouvert', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [, oct] = await echeancesDu(p, lease.id);
      await payerEspeces(p, lease.id, 100000, { scheduleId: oct.id });
      expect((await ligne('SELECT status FROM rent_schedules WHERE id = :id', { id: oct.id })).status).toBe('partiellement_paye');
      const solde = await payerEspeces(p, lease.id, 250000, { scheduleId: oct.id });
      expect((await ligne('SELECT status FROM rent_schedules WHERE id = :id', { id: oct.id })).status).toBe('paye');
      await api().post(`/api/v1/paiements/${solde.payment.id}/rembourser`).set(p.h).send({ reason: 'Erreur' });
      expect(await ligne('SELECT status, amount_paid FROM rent_schedules WHERE id = :id', { id: oct.id })).toEqual({ status: 'partiellement_paye', amount_paid: 100000 });
    });
  });

  describe('espace locataire', () => {
    test('le locataire voit SES échéances (hors annulées), sans champs internes ; détail avec paiement et quittance', async () => {
      const p = await nouveauProprietaire();
      const a = await bailActif(p);
      const b = await bailActif(p);
      const locA = await activerLocataire(p, a.tenant);
      const locB = await activerLocataire(p, b.tenant);
      const [sept, oct] = await echeancesDu(p, a.lease.id);
      const r = await payerEspeces(p, a.lease.id, 350000, { scheduleId: sept.id });
      await annuler(p, oct.id);
      const liste = await api().get('/api/v1/locataire/echeances?limit=100').set(locA.h);
      expect(liste.status).toBe(200);
      const ids = liste.body.data.items.map((e) => e.id);
      expect(ids).toContain(sept.id);
      expect(ids).not.toContain(oct.id);
      expect(liste.body.data.items.every((e) => e.lease_id === a.lease.id)).toBe(true);
      expect(liste.body.data.items[0]).not.toHaveProperty('owner_id');
      const d = (await api().get(`/api/v1/locataire/echeances/${sept.id}`).set(locA.h)).body.data.schedule;
      expect(d).toMatchObject({ id: sept.id, status: 'paye', receipt: { id: r.receipts[0].id } });
      expect(d).not.toHaveProperty('owner_id');
      expect(d).not.toHaveProperty('cancel_reason');
      expect(d.allocations[0].payment).toMatchObject({ reference: r.payment.reference });

      expect((await api().get('/api/v1/locataire/echeances?limit=100').set(locB.h)).body.data.items.map((e) => e.id)).not.toContain(sept.id);
      const refus = await api().get(`/api/v1/locataire/echeances/${sept.id}`).set(locB.h);
      expect(refus.status).toBe(403);
      expect(refus.body.error.code).toBe('ACCES_AUTRE_LOCATAIRE');
      expect((await api().get(`/api/v1/locataire/echeances/${UUID_ABSENT}`).set(locA.h)).status).toBe(404);
      expect((await api().get('/api/v1/locataire/echeances/abc').set(locA.h)).status).toBe(422);
    });

    test('filtres locataire : à payer, statut, période, ordre ; pagination ; paramètres invalides → 422', async () => {
      const { proprio: p, locataire: loc, lease } = await proprietaireEtLocataire();
      const [sept] = await echeancesDu(p, lease.id);
      const q = async (qs) => (await api().get(`/api/v1/locataire/echeances?limit=100&${qs}`).set(loc.h)).body.data;
      expect((await q('a_payer=true')).items.map((e) => e.id)).toEqual([sept.id]);
      expect((await q('status=en_retard')).items.map((e) => e.id)).toEqual([sept.id]);
      expect((await q('du=2026-09-01&au=2026-09-30')).items.map((e) => e.id)).toEqual([sept.id]);
      const asc = (await q('ordre=asc')).items;
      expect(asc[0].id).toBe(sept.id);
      const desc = (await q('')).items;
      expect(desc[desc.length - 1].id).toBe(sept.id);
      expect((await q(`lease_id=${lease.id}`)).pagination.total).toBe(desc.length);
      const p1 = await api().get('/api/v1/locataire/echeances?limit=2').set(loc.h);
      expect(p1.body.data.pagination).toEqual({ page: 1, limit: 2, total: desc.length, totalPages: Math.ceil(desc.length / 2) });
      expect((await api().get('/api/v1/locataire/echeances?page=500').set(loc.h)).body.data.items).toEqual([]);
      expect((await api().get('/api/v1/locataire/echeances?limit=5000').set(loc.h)).body.data.pagination.limit).toBe(100);
      for (const qs of ['page=0', 'limit=0', 'limit=abc', 'ordre=aleatoire', 'status=inconnu', 'a_payer=peut-etre', 'lease_id=x', 'du=hier']) {
        expect((await api().get(`/api/v1/locataire/echeances?${qs}`).set(loc.h)).status).toBe(422);
      }
    });
  });
});
