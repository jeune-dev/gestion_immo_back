'use strict';

const zlib = require('zlib');
const {
  api, nouveauProprietaire, bailActif, activerLocataire, proprietaireEtLocataire, fermer, compter, payerEspeces,
} = require('../../../setup/helpers.js');
const {
  UUID_ABSENT, echeancesDu, ligne, verifierAuthentification, verifierCompteDesactive, restreindrePermissions,
} = require('../paiements/outils.paiements.js');

/**
 * Quittances (§ 13 : consulter, télécharger, partager ; § 44 « Loyer PAYÉ →
 * Quittance ») côté propriétaire et locataire :
 *   GET /quittances · GET /quittances/:id · GET /quittances/:id/pdf
 *   GET /locataire/quittances · GET /locataire/quittances/:id · GET /locataire/quittances/:id/pdf
 */

/** Texte d'un PDF pdfkit (polices standard, flux compressés) — suffisant pour vérifier le contenu. */
function texteDuPdf(buffer) {
  const brut = buffer.toString('latin1');
  const morceaux = [];
  const flux = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = flux.exec(brut))) {
    let contenu;
    try { contenu = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const operation of contenu.match(/\[(.*?)\]\s*TJ/g) || []) {
      morceaux.push((operation.match(/<([0-9a-fA-F]*)>/g) || []).map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join(''));
    }
  }
  return morceaux.join('\n');
}

/** Quittance payée en espèces pour la première échéance d'un bail. */
async function quittancePayee(p, lease, montant = 350000, paidOn = '2026-09-05') {
  const [sept] = await echeancesDu(p, lease.id);
  const r = await payerEspeces(p, lease.id, montant, { scheduleId: sept.id, paidOn });
  return { receipt: r.receipts[0], payment: r.payment, schedule: sept };
}

afterAll(fermer);

describe('Quittances', () => {

  describe('authentification et autorisations', () => {
    const proprio = [
      ['GET', '/api/v1/quittances', null],
      ['GET', `/api/v1/quittances/${UUID_ABSENT}`, null],
      ['GET', `/api/v1/quittances/${UUID_ABSENT}/pdf`, null],
    ];
    const locataire = [
      ['GET', '/api/v1/locataire/quittances', null],
      ['GET', `/api/v1/locataire/quittances/${UUID_ABSENT}`, null],
      ['GET', `/api/v1/locataire/quittances/${UUID_ABSENT}/pdf`, null],
    ];

    test.each(proprio)('%s %s : 401 sans jeton valide', async (m, url, c) => {
      await verifierAuthentification(m, url, await nouveauProprietaire(), c);
    });

    test.each(locataire)('%s %s : 401 sans jeton valide', async (m, url, c) => {
      const { locataire: loc } = await proprietaireEtLocataire();
      await verifierAuthentification(m, url, loc, c);
    });

    test('comptes désactivés → 403 ; rôle croisé (locataire ↔ propriétaire) → 403', async () => {
      const { proprio: p, locataire: loc } = await proprietaireEtLocataire();
      for (const [, url] of proprio) expect((await api().get(url).set(loc.h)).status).toBe(403);
      for (const [, url] of locataire) expect((await api().get(url).set(p.h)).status).toBe(403);
      await verifierCompteDesactive(proprio, p);
      await verifierCompteDesactive(locataire, loc);
    });

    test('permission « quittances.lire » requise côté propriétaire', async () => {
      const p = await nouveauProprietaire();
      await restreindrePermissions(p, ['paiements.lire']);
      const res = await api().get('/api/v1/quittances').set(p.h);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PERMISSION_REFUSEE');
    });
  });

  describe('espace propriétaire', () => {
    test('§ 13 contenu : bien, locataire, loyer, date, statut PAYÉ, référence(s) ; détail joint', async () => {
      const p = await nouveauProprietaire();
      const { lease, building, apartment, tenant } = await bailActif(p);
      const { receipt, payment, schedule } = await quittancePayee(p, lease);
      const res = await api().get(`/api/v1/quittances/${receipt.id}`).set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.receipt).toMatchObject({
        id: receipt.id, amount: 350000, payment_references: [payment.reference], cancelled_at: null,
        tenant: { id: tenant.id, first_name: 'Mamadou', last_name: 'Ndiaye' },
        schedule: { id: schedule.id, amount_due: 350000, apartment: { id: apartment.id, number: apartment.number, building: { id: building.id, name: building.name } } },
      });

      const pdf = await api().get(`/api/v1/quittances/${receipt.id}/pdf`).buffer(true).parse((r, cb) => {
        const parts = [];
        r.on('data', (c) => parts.push(c));
        r.on('end', () => cb(null, Buffer.concat(parts)));
      }).set(p.h);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.headers['cache-control']).toBe('private, no-store');
      expect(pdf.headers['content-disposition']).toBe(`inline; filename="${receipt.number}.pdf"`);
      expect(Number(pdf.headers['content-length'])).toBe(pdf.body.length);
      const texte = texteDuPdf(pdf.body);
      for (const attendu of ['QUITTANCE DE LOYER', receipt.number, building.name, `Appartement ${apartment.number}`, 'Mamadou Ndiaye', 'PAYÉ', payment.reference, 'Loyer septembre 2026']) {
        expect(texte).toContain(attendu);
      }
      expect(texte.replace(/\s/g, ' ')).toMatch(/350.000 FCFA/);
    });

    test('liste : filtres bail, locataire, période, annulées ; tri par montant ; pagination exacte', async () => {
      const p = await nouveauProprietaire();
      const a = await bailActif(p);
      const b = await bailActif(p, { appartement: { rent_amount: 200000 } });
      const qa = await quittancePayee(p, a.lease);
      const qb = await quittancePayee(p, b.lease, 200000);
      const ids = async (qs) => (await api().get(`/api/v1/quittances?${qs}`).set(p.h)).body.data.items.map((i) => i.id);
      expect((await ids('tri=amount'))).toEqual([qb.receipt.id, qa.receipt.id]);
      expect((await ids('tri=-amount'))).toEqual([qa.receipt.id, qb.receipt.id]);
      expect(await ids(`lease_id=${a.lease.id}`)).toEqual([qa.receipt.id]);
      expect(await ids(`tenant_id=${b.tenant.id}`)).toEqual([qb.receipt.id]);
      const jour = new Date().toISOString().slice(0, 10);
      expect((await ids(`du=${jour}&au=${jour}`)).sort()).toEqual([qa.receipt.id, qb.receipt.id].sort());
      expect(await ids('au=2000-01-01')).toEqual([]);
      const page = await api().get('/api/v1/quittances?limit=1&page=2&tri=amount').set(p.h);
      expect(page.body.data.items.map((i) => i.id)).toEqual([qa.receipt.id]);
      expect(page.body.data.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
      expect((await api().get('/api/v1/quittances?page=3&limit=1').set(p.h)).body.data.items).toEqual([]);
      expect((await api().get('/api/v1/quittances?limit=1000').set(p.h)).body.data.pagination.limit).toBe(100);

      await api().post(`/api/v1/paiements/${qa.payment.id}/rembourser`).set(p.h).send({ reason: 'Erreur de saisie' });
      expect(await ids('')).toEqual([qb.receipt.id]);
      expect((await ids('inclure_annulees=true')).sort()).toEqual([qa.receipt.id, qb.receipt.id].sort());
      const annulee = (await api().get(`/api/v1/quittances/${qa.receipt.id}`).set(p.h)).body.data.receipt;
      expect(annulee.cancelled_at).not.toBeNull();
      expect(annulee.cancel_reason).toBe(`Remboursement du paiement ${qa.payment.reference}`);
      // Le propriétaire garde l'accès au PDF d'une quittance annulée (audit, § 42).
      expect((await api().get(`/api/v1/quittances/${qa.receipt.id}/pdf`).set(p.h)).status).toBe(200);
    });

    test('liste vide ; isolation entre propriétaires ; autre propriétaire → 403 (détail et PDF) ; introuvable → 404 ; UUID invalide → 422', async () => {
      const a = await nouveauProprietaire();
      const b = await nouveauProprietaire();
      expect((await api().get('/api/v1/quittances').set(b.h)).body.data).toEqual({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
      const { lease } = await bailActif(a);
      const { receipt } = await quittancePayee(a, lease);
      expect((await api().get('/api/v1/quittances').set(b.h)).body.data.items).toEqual([]);
      expect((await api().get(`/api/v1/quittances?lease_id=${lease.id}`).set(b.h)).body.data.items).toEqual([]);
      for (const suffixe of ['', '/pdf']) {
        const res = await api().get(`/api/v1/quittances/${receipt.id}${suffixe}`).set(b.h);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ACCES_AUTRE_PROPRIETAIRE');
        expect((await api().get(`/api/v1/quittances/${UUID_ABSENT}${suffixe}`).set(a.h)).status).toBe(404);
        expect((await api().get(`/api/v1/quittances/1${suffixe}`).set(a.h)).status).toBe(422);
      }
    });

    test.each(['page=0', 'limit=0', 'limit=abc', 'tri=number', 'du=2026-9-1', 'lease_id=<script>', 'inclure_annulees=peut-etre'])('paramètre invalide %s → 422', async (qs) => {
      const p = await nouveauProprietaire();
      expect((await api().get(`/api/v1/quittances?${qs}`).set(p.h)).status).toBe(422);
    });

    test('§ 13 plusieurs paiements soldent une échéance : une quittance aux deux références ; paiement partiel : aucune quittance', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p);
      const [sept] = await echeancesDu(p, lease.id);
      const a = await payerEspeces(p, lease.id, 150000, { scheduleId: sept.id });
      expect(a.receipts).toEqual([]);
      expect(await compter('receipts', 'rent_schedule_id = :id', { id: sept.id })).toBe(0);
      const b = await payerEspeces(p, lease.id, 200000, { scheduleId: sept.id });
      expect(b.receipts[0].payment_references).toEqual([a.payment.reference, b.payment.reference]);
      expect(await compter('documents', "entity_type = 'receipt' AND entity_id = :id AND category = 'quittance' AND visible_to_tenant", { id: b.receipts[0].id })).toBe(1);
    });
  });

  describe('espace locataire', () => {
    test('le locataire consulte et télécharge SES quittances ; jamais celles d’un autre', async () => {
      const p = await nouveauProprietaire();
      const a = await bailActif(p);
      const b = await bailActif(p);
      const locA = await activerLocataire(p, a.tenant);
      const locB = await activerLocataire(p, b.tenant);
      const { receipt } = await quittancePayee(p, a.lease);
      const liste = await api().get('/api/v1/locataire/quittances').set(locA.h);
      expect(liste.status).toBe(200);
      expect(liste.body.data.items.map((i) => i.id)).toEqual([receipt.id]);
      expect(liste.body.data.pagination.total).toBe(1);
      const detail = await api().get(`/api/v1/locataire/quittances/${receipt.id}`).set(locA.h);
      expect(detail.body.data.receipt).toMatchObject({ id: receipt.id, number: receipt.number, amount: 350000 });
      const pdf = await api().get(`/api/v1/locataire/quittances/${receipt.id}/pdf`).set(locA.h);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');

      expect((await api().get('/api/v1/locataire/quittances').set(locB.h)).body.data.items).toEqual([]);
      for (const suffixe of ['', '/pdf']) {
        const res = await api().get(`/api/v1/locataire/quittances/${receipt.id}${suffixe}`).set(locB.h);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ACCES_AUTRE_LOCATAIRE');
        expect((await api().get(`/api/v1/locataire/quittances/${UUID_ABSENT}${suffixe}`).set(locA.h)).status).toBe(404);
        expect((await api().get(`/api/v1/locataire/quittances/abc${suffixe}`).set(locA.h)).status).toBe(422);
      }
    });

    test('quittance annulée (remboursement) : invisible du locataire, même avec inclure_annulees=true', async () => {
      const { proprio: p, locataire: loc, lease } = await proprietaireEtLocataire();
      const { receipt, payment } = await quittancePayee(p, lease);
      await api().post(`/api/v1/paiements/${payment.id}/rembourser`).set(p.h).send({ reason: 'Chèque rejeté' });
      expect((await api().get('/api/v1/locataire/quittances?inclure_annulees=true').set(loc.h)).body.data.items).toEqual([]);
      expect((await api().get(`/api/v1/locataire/quittances/${receipt.id}`).set(loc.h)).status).toBe(404);
      expect((await api().get(`/api/v1/locataire/quittances/${receipt.id}/pdf`).set(loc.h)).status).toBe(404);
      const doc = await ligne('SELECT visible_to_tenant FROM documents WHERE id = (SELECT document_id FROM receipts WHERE id = :id)', { id: receipt.id });
      expect(doc.visible_to_tenant).toBe(false);
    });

    test('pagination et filtres locataire : page 1/2, au-delà, limite plafonnée, paramètres invalides → 422', async () => {
      const { proprio: p, locataire: loc, lease } = await proprietaireEtLocataire();
      const [e1, e2] = await echeancesDu(p, lease.id);
      await payerEspeces(p, lease.id, 350000, { scheduleId: e1.id });
      await payerEspeces(p, lease.id, 350000, { scheduleId: e2.id });
      const p1 = await api().get('/api/v1/locataire/quittances?limit=1').set(loc.h);
      expect(p1.body.data.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
      const p2 = await api().get('/api/v1/locataire/quittances?limit=1&page=2').set(loc.h);
      expect(p2.body.data.items[0].id).not.toBe(p1.body.data.items[0].id);
      expect((await api().get('/api/v1/locataire/quittances?page=3&limit=1').set(loc.h)).body.data.items).toEqual([]);
      expect((await api().get('/api/v1/locataire/quittances?limit=999').set(loc.h)).body.data.pagination.limit).toBe(100);
      expect((await api().get(`/api/v1/locataire/quittances?lease_id=${lease.id}`).set(loc.h)).body.data.items).toHaveLength(2);
      for (const qs of ['page=0', 'limit=0', 'limit=x', 'lease_id=1', 'du=demain']) {
        expect((await api().get(`/api/v1/locataire/quittances?${qs}`).set(loc.h)).status).toBe(422);
      }
    });
  });
});

describe('CORRECTIF M10 — PDF de quittance produit APRÈS le paiement, jamais pendant', () => {
  const storage = require('../../../../infrastructure/storage.service.js');
  const quittancesService = require('../../../../modules/quittance/service/quittance.service.js');
  const { sequelize } = require('../../../setup/helpers.js');
  const { aujourdhui } = require('../../../../utils/dates.js');

  test('stockage en panne au paiement : le paiement RÉUSSIT, la quittance existe sans PDF, puis la tâche de rattrapage le produit', async () => {
    const { proprio: p, lease } = await require('../../../setup/helpers.js').proprietaireEtLocataire();
    const [sept] = await require('../../../setup/helpers.js').echeancesDu(p, lease.id);
    const panne = jest.spyOn(storage, 'enregistrer').mockRejectedValue(new Error('stockage injoignable'));
    let res;
    try {
      res = await api().post('/api/v1/paiements/especes').set(p.h)
        .send({ lease_id: lease.id, rent_schedule_id: sept.id, amount: sept.amount_due, paid_on: aujourdhui() });
    } finally {
      panne.mockRestore();
    }
    expect(res.status).toBe(201);
    const [[recu]] = await sequelize.query('SELECT id, document_id FROM receipts WHERE rent_schedule_id = :e', { replacements: { e: sept.id } });
    expect(recu.document_id).toBeNull();
    // PDF demandé pendant ce temps : 503 réessayable, jamais une erreur interne.
    const pdf = await api().get(`/api/v1/quittances/${recu.id}/pdf`).set(p.h);
    expect(pdf.status).toBe(503);
    expect(pdf.body.error.code).toBe('QUITTANCE_EN_PREPARATION');
    // Rattrapage (la tâche ne traite que les quittances de plus de 2 min).
    await sequelize.query("UPDATE receipts SET issued_at = now() - interval '5 minutes' WHERE id = :r", { replacements: { r: recu.id } });
    expect((await quittancesService.produireDocumentsManquants()).produites).toBeGreaterThanOrEqual(1);
    expect((await api().get(`/api/v1/quittances/${recu.id}/pdf`).set(p.h)).status).toBe(200);
  });

  test('le PDF est stocké APRÈS la validation du paiement (jamais pendant sa transaction)', async () => {
    const { proprio: p, lease } = await require('../../../setup/helpers.js').proprietaireEtLocataire();
    const [sept] = await require('../../../setup/helpers.js').echeancesDu(p, lease.id);
    const reel = storage.enregistrer.bind(storage);
    const visibles = [];
    // Au moment du stockage, la quittance doit être visible depuis une AUTRE
    // connexion, donc déjà VALIDÉE : avant le correctif, le PDF était stocké
    // à l'intérieur de la transaction du paiement (quittance encore invisible).
    const espion = jest.spyOn(storage, 'enregistrer').mockImplementation(async (...args) => {
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM receipts WHERE rent_schedule_id = :e', { replacements: { e: sept.id } });
      visibles.push(n);
      return reel(...args);
    });
    try {
      expect((await api().post('/api/v1/paiements/especes').set(p.h)
        .send({ lease_id: lease.id, rent_schedule_id: sept.id, amount: sept.amount_due, paid_on: aujourdhui() })).status).toBe(201);
    } finally {
      espion.mockRestore();
    }
    expect(visibles).toEqual([1]);
    const [[recu]] = await sequelize.query('SELECT document_id FROM receipts WHERE rent_schedule_id = :e', { replacements: { e: sept.id } });
    expect(recu.document_id).not.toBeNull();
  });
});
