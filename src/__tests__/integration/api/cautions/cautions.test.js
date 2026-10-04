'use strict';

const fs = require('fs');
const path = require('path');
const {
  api, nouveauProprietaire, superAdmin, bailActif, activerLocataire, proprietaireEtLocataire, pngTest,
  fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const storage = require('../../../../infrastructure/storage.service.js');
const { aujourdhui } = require('../../../../utils/dates.js');
const {
  UUID_INCONNU, jetonsDegrades, verifierMatrice, verifierStatuts, proprietaireSansPermission,
} = require('../baux/securite.outils.js');

/**
 * Cycle de vie de la caution (§ 55) — toutes les routes /cautions et
 * /locataire/caution : versement, justificatif, retenue justifiée, restitution,
 * contestation et réponse, statuts du § 55.2, exclusion des revenus (§ 55.4),
 * clôture du bail, isolation, validation, fichiers, concurrence et ordre des
 * verrous (interblocage).
 */

const BASE = '/api/v1/cautions';
const LOC = '/api/v1/locataire/caution';
const EDL = '/api/v1/etats-des-lieux';

const verser = (p, id, amount, extra = {}) => api().post(`${BASE}/${id}/versements`).set(p.h)
  .send({ amount, occurred_on: '2026-09-01', method: 'especes', ...extra });
const restituer = (p, id, amount) => api().post(`${BASE}/${id}/restitutions`).set(p.h)
  .send({ amount, occurred_on: '2026-12-15', method: 'wave', reference: 'WV-REST-1' });
const justificatif = async (p, id) => {
  const res = await api().post(`${BASE}/${id}/justificatifs`).set(p.h).attach('fichier', await pngTest('#0a0'), 'degat.png');
  if (res.status !== 201) throw new Error(`Justificatif : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.document.id;
};
const retenir = (p, id, amount, pieces, extra = {}) => api().post(`${BASE}/${id}/retenues`).set(p.h)
  .send({ amount, reason: 'degradation', description: 'Porte de la chambre cassée', justification_document_ids: pieces, ...extra });

/**
 * Propriétaire + bail actif + locataire activé + id de la caution (700 000 attendus).
 * `versee` : caution versée intégralement ; `terminee` : bail terminé ensuite.
 */
async function dossier({ versee = false, terminee = false } = {}) {
  const d = await proprietaireEtLocataire();
  const [[{ id }]] = await sequelize.query('SELECT id FROM deposits WHERE lease_id = :l', { replacements: { l: d.lease.id } });
  if (versee) expect((await verser(d.proprio, id, 700000)).status).toBe(201);
  if (terminee) expect((await api().post(`/api/v1/baux/${d.lease.id}/terminer`).set(d.proprio.h).send({ ended_on: '2026-11-30' })).status).toBe(200);
  return { ...d, p: d.proprio, depositId: id };
}

const ligneCaution = async (id) => (await sequelize.query('SELECT * FROM deposits WHERE id = :id', { replacements: { id } }))[0][0];

describe('Caution (§ 55)', () => {
  afterAll(fermer);

  describe('lecture', () => {
    test('liste : vide pour un nouvel espace ; filtres, tri, pagination, jamais les cautions d’autrui', async () => {
      const vide = await nouveauProprietaire();
      expect((await api().get(BASE).set(vide.h)).body.data.items).toEqual([]);

      const p = await nouveauProprietaire();
      const b1 = await bailActif(p);
      const b2 = await bailActif(p);
      const [[d1]] = await sequelize.query('SELECT id FROM deposits WHERE lease_id = :l', { replacements: { l: b1.lease.id } });
      await verser(p, d1.id, 700000);
      await bailActif(await nouveauProprietaire());

      const tous = await api().get(BASE).set(p.h);
      expect(tous.status).toBe(200);
      expect(tous.body.data.pagination.total).toBe(2);
      expect(tous.body.data.items.every((d) => d.owner_id === p.ownerId)).toBe(true);
      expect(tous.body.data.items[0]).toHaveProperty('lease.apartment.building.name');
      expect(tous.body.data.items[0]).toHaveProperty('tenant.first_name');

      const detenues = await api().get(`${BASE}?detenues=true`).set(p.h);
      expect(detenues.body.data.items.map((d) => d.id)).toEqual([d1.id]);
      expect((await api().get(`${BASE}?status=attendue`).set(p.h)).body.data.items.map((d) => d.lease_id)).toEqual([b2.lease.id]);
      expect((await api().get(`${BASE}?tenant_id=${b1.tenant.id}`).set(p.h)).body.data.items.map((d) => d.id)).toEqual([d1.id]);
      expect((await api().get(`${BASE}?lease_id=${b2.lease.id}`).set(p.h)).body.data.pagination.total).toBe(1);
      const tri = await api().get(`${BASE}?tri=-amount_received`).set(p.h);
      expect(tri.body.data.items.map((d) => d.amount_received)).toEqual([700000, 0]);
      const p2 = await api().get(`${BASE}?limit=1&page=2`).set(p.h);
      expect(p2.body.data.items).toHaveLength(1);
      expect(p2.body.data.pagination).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });
      expect((await api().get(`${BASE}?limit=1&page=3`).set(p.h)).body.data.items).toEqual([]);
      expect((await api().get(`${BASE}?limit=1000`).set(p.h)).body.data.pagination.limit).toBe(100);

      const ecarts = await verifierStatuts([
        ['get', `${BASE}?page=0`, undefined, 422],
        ['get', `${BASE}?page=-1`, undefined, 422],
        ['get', `${BASE}?limit=0`, undefined, 422],
        ['get', `${BASE}?status=perdue`, undefined, 422],
        ['get', `${BASE}?tri=owner_id`, undefined, 422],
        ['get', `${BASE}?tenant_id=${encodeURIComponent("1' OR '1'='1")}`, undefined, 422],
        ['get', `${BASE}?detenues=peut-etre`, undefined, 422],
      ], p.h);
      expect(ecarts).toEqual([]);
    });

    test('détail : mouvements et solde ; 404, 403, 422', async () => {
      const { p, depositId } = await dossier({ versee: true });
      const autre = await nouveauProprietaire();
      const res = await api().get(`${BASE}/${depositId}`).set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.deposit).toMatchObject({ id: depositId, amount_expected: 700000, amount_received: 700000, balance: 700000, status: 'detenue' });
      expect(res.body.data.deposit.transactions).toHaveLength(1);
      expect(res.body.data.deposit.transactions[0]).toMatchObject({ type: 'versement', amount: 700000, method: 'especes' });
      expect((await api().get(`${BASE}/${UUID_INCONNU}`).set(p.h)).status).toBe(404);
      expect((await api().get(`${BASE}/${depositId}`).set(autre.h)).status).toBe(403);
      expect((await api().get(`${BASE}/123`).set(p.h)).status).toBe(422);
    });
  });

  describe('versement (§ 55.3)', () => {
    test('versements partiel puis complet : statuts, caisse is_deposit, reçu PDF stocké et partagé, audit, notification', async () => {
      const { p, locataire, lease, depositId } = await dossier();
      expect((await ligneCaution(depositId)).status).toBe('attendue');
      const v1 = await verser(p, depositId, 300000, { method: 'wave', reference: 'WV-123' });
      expect(v1.status).toBe(201);
      expect(v1.body.data.deposit).toMatchObject({ status: 'partiellement_versee', amount_received: 300000 });
      expect(v1.body.data.transaction).toMatchObject({ type: 'versement', amount: 300000, method: 'wave', reference: 'WV-123' });
      const v2 = await verser(p, depositId, 400000);
      expect(v2.body.data.deposit).toMatchObject({ status: 'detenue', amount_received: 700000 });

      const [mouvements] = await sequelize.query(
        "SELECT direction, category, is_deposit, amount FROM cash_movements WHERE source_type = 'deposit_transaction' AND source_id IN (:ids) ORDER BY amount",
        { replacements: { ids: [v1.body.data.transaction.id, v2.body.data.transaction.id] } }
      );
      expect(mouvements).toEqual([
        { direction: 'entree', category: 'caution', is_deposit: true, amount: 300000 },
        { direction: 'entree', category: 'caution', is_deposit: true, amount: 400000 },
      ]);

      const [[recu]] = await sequelize.query(
        'SELECT d.id, d.category, d.visible_to_tenant, d.tenant_id, d.storage_key FROM deposit_transactions t JOIN documents d ON d.id = t.receipt_document_id WHERE t.id = :id',
        { replacements: { id: v1.body.data.transaction.id } }
      );
      expect(recu).toMatchObject({ category: 'recu', visible_to_tenant: true, tenant_id: lease.tenant_id });
      expect((await storage.lire(recu.storage_key)).subarray(0, 5).toString()).toBe('%PDF-');
      expect((await api().get(`/api/v1/documents/${recu.id}/fichier`).set(locataire.h)).status).toBe(200);
      // Le reçu est une pièce probante : ni supprimable ni masquable.
      expect((await api().delete(`/api/v1/documents/${recu.id}`).set(p.h)).status).toBe(409);
      expect((await api().patch(`/api/v1/documents/${recu.id}`).set(p.h).send({ visible_to_tenant: false })).status).toBe(409);

      expect(await compter('audit_logs', "action = 'caution.versement' AND entity_id = :id", { id: depositId })).toBe(2);
      expect(await compter('notifications', "user_id = :u AND type = 'caution'", { u: locataire.user.id })).toBe(2);
    });

    test('validation et dépassement : 422, aucune ligne créée', async () => {
      const { p, depositId } = await dossier();
      const u = `${BASE}/${depositId}/versements`;
      const ok = { amount: 1000, occurred_on: '2026-09-01', method: 'especes' };
      const ecarts = await verifierStatuts([
        ['post', u, {}, 422],
        ['post', u, { ...ok, amount: 0 }, 422],
        ['post', u, { ...ok, amount: -100 }, 422],
        ['post', u, { ...ok, amount: 10.5 }, 422],
        ['post', u, { ...ok, amount: 'mille' }, 422],
        ['post', u, { ...ok, method: 'bitcoin' }, 422],
        ['post', u, { ...ok, method: undefined }, 422],
        ['post', u, { ...ok, occurred_on: '2026-13-01' }, 422],
        ['post', u, { ...ok, reference: 'R'.repeat(65) }, 422],
        ['post', u, { ...ok, amount: 700001 }, 422],
        ['post', `${BASE}/pas-un-uuid/versements`, ok, 422],
        ['post', `${BASE}/${UUID_INCONNU}/versements`, ok, 404],
      ], p.h);
      expect(ecarts).toEqual([]);
      expect(await compter('deposit_transactions', 'deposit_id = :id', { id: depositId })).toBe(0);
      const trop = await verser(p, depositId, 700001);
      expect(trop.body.error.code).toBe('CAUTION_DEPASSEE');
    });

    test('bail clos → 409 BAIL_INVALIDE ; même Idempotency-Key rejouée → un seul versement', async () => {
      const { p, depositId } = await dossier();
      const cle = `versement-${depositId.slice(0, 8)}`;
      const a = await api().post(`${BASE}/${depositId}/versements`).set(p.h).set('Idempotency-Key', cle).send({ amount: 1000, occurred_on: '2026-09-01', method: 'especes' });
      const b = await api().post(`${BASE}/${depositId}/versements`).set(p.h).set('Idempotency-Key', cle).send({ amount: 1000, occurred_on: '2026-09-01', method: 'especes' });
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(await compter('deposit_transactions', 'deposit_id = :id', { id: depositId })).toBe(1);

      const clos = await dossier();
      await api().post(`/api/v1/baux/${clos.lease.id}/terminer`).set(clos.p.h).send({ ended_on: '2026-10-31' });
      expect((await api().post(`/api/v1/baux/${clos.lease.id}/cloturer`).set(clos.p.h).send({})).status).toBe(200);
      const refus = await verser(clos.p, clos.depositId, 1000);
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('BAIL_INVALIDE');
    });

    test('§ 55.4 la caution n’est pas un revenu : tableau de bord, caisse, rentabilité', async () => {
      const { p, apartment, depositId } = await dossier();
      await verser(p, depositId, 700000, { occurred_on: aujourdhui() });
      const tableau = await api().get('/api/v1/dashboard').set(p.h);
      expect(tableau.status).toBe(200);
      expect(tableau.body.data.dashboard.revenus.total).toBe(0);
      expect(Number(tableau.body.data.dashboard.cautions_detenues)).toBe(700000);
      const mois = aujourdhui().slice(0, 7);
      const caisse = await api().get(`/api/v1/caisse/synthese?du=${mois}-01&au=${aujourdhui()}`).set(p.h);
      expect(caisse.body.data.caisse.entrees).toBe(0);
      expect(caisse.body.data.caisse.cautions.recues).toBe(700000);
      const rentabilite = await api().get(`/api/v1/appartements/${apartment.id}/rentabilite?du=${mois}-01&au=${aujourdhui()}`).set(p.h);
      expect(rentabilite.body.data.rentabilite.resultat_net).toBe(0);
    });
  });

  describe('justificatif', () => {
    test('photo de dégât : document de la caution, visible du locataire, fichier stocké', async () => {
      const { p, locataire, depositId, tenant } = await dossier();
      const res = await api().post(`${BASE}/${depositId}/justificatifs`).set(p.h).attach('fichier', await pngTest(), 'porte.png');
      expect(res.status).toBe(201);
      expect(res.body.data.document).toMatchObject({ category: 'justificatif', visible_to_tenant: true, has_thumbnail: true, mime_type: 'image/png' });
      expect(res.body.data.document).not.toHaveProperty('storage_key');
      const [[doc]] = await sequelize.query('SELECT entity_type, entity_id, tenant_id, storage_key FROM documents WHERE id = :id', { replacements: { id: res.body.data.document.id } });
      expect(doc).toMatchObject({ entity_type: 'deposit', entity_id: depositId, tenant_id: tenant.id });
      expect(fs.existsSync(path.join(storage.UPLOAD_DIR, ...doc.storage_key.split('/')))).toBe(true);
      expect((await api().get(`/api/v1/documents/${res.body.data.document.id}/fichier`).set(locataire.h)).status).toBe(200);
    });

    test('fichier refusé (texte ou exécutable déguisé en .png, trop gros, absent) → 400, ni ligne ni fichier', async () => {
      const { p, depositId } = await dossier();
      const dossierStockage = path.join(storage.UPLOAD_DIR, 'owners', p.ownerId, 'deposit');
      const u = `${BASE}/${depositId}/justificatifs`;
      const texte = await api().post(u).set(p.h).attach('fichier', Buffer.from('ceci est un simple texte, pas une image'), 'photo.png');
      expect(texte.status).toBe(400);
      expect(texte.body.error.code).toBe('FORMAT_FICHIER_REFUSE');
      const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
      expect((await api().post(u).set(p.h).attach('fichier', exe, 'virus.png')).status).toBe(400);
      const gros = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(10.5 * 1024 * 1024)]);
      const tropGros = await api().post(u).set(p.h).attach('fichier', gros, 'enorme.png');
      expect(tropGros.status).toBe(400);
      expect(tropGros.body.error.code).toBe('FICHIER_TROP_VOLUMINEUX');
      expect((await api().post(u).set(p.h).send({})).status).toBe(400);
      expect(await compter('documents', "entity_type = 'deposit' AND entity_id = :id", { id: depositId })).toBe(0);
      expect(fs.existsSync(dossierStockage) ? fs.readdirSync(dossierStockage) : []).toEqual([]);
    });
  });

  describe('retenue (§ 55.3, § 55.4)', () => {
    test('pendant le bail → 409 ; sans justificatif → 422 ; au-delà du solde → 422 ; validation', async () => {
      const actif = await dossier({ versee: true });
      const piece = await justificatif(actif.p, actif.depositId);
      const pendant = await retenir(actif.p, actif.depositId, 1000, [piece]);
      expect(pendant.status).toBe(409);
      expect(pendant.body.error.code).toBe('BAIL_NON_TERMINE');

      const { p, depositId } = await dossier({ versee: true, terminee: true });
      const j = await justificatif(p, depositId);
      const u = `${BASE}/${depositId}/retenues`;
      const ok = { amount: 1000, reason: 'degradation', description: 'Vitre brisée', justification_document_ids: [j] };
      const ecarts = await verifierStatuts([
        ['post', u, { ...ok, justification_document_ids: [] }, 422],
        ['post', u, { ...ok, justification_document_ids: undefined }, 422],
        ['post', u, { ...ok, reason: undefined }, 422],
        ['post', u, { ...ok, reason: 'caprice' }, 422],
        ['post', u, { ...ok, description: 'abc' }, 422],
        ['post', u, { ...ok, description: 'x'.repeat(2001) }, 422],
        ['post', u, { ...ok, amount: 0 }, 422],
        ['post', u, { ...ok, amount: -10 }, 422],
        ['post', u, { ...ok, justification_document_ids: ['pas-un-uuid'] }, 422],
        ['post', u, { ...ok, justification_document_ids: [j, j] }, 422],
        ['post', u, { ...ok, inspection_item_ids: ['x'] }, 422],
        ['post', u, { ...ok, amount: 700001 }, 422],
        ['post', u, { ...ok, justification_document_ids: [UUID_INCONNU] }, 403],
      ], p.h);
      expect(ecarts).toEqual([]);
      expect(await compter('deposit_transactions', "deposit_id = :id AND type = 'retenue'", { id: depositId })).toBe(0);
      expect((await retenir(p, depositId, 700001, [j])).body.error.code).toBe('RETENUE_SUPERIEURE_AU_SOLDE');
    });

    test('AUDIT #6 : un justificatif étranger au dossier du bail est refusé (403 JUSTIFICATIF_INVALIDE)', async () => {
      const { p, depositId, building, tenant } = await dossier({ versee: true, terminee: true });
      const autre = await bailActif(p);
      const [[autreCaution]] = await sequelize.query('SELECT id FROM deposits WHERE lease_id = :l', { replacements: { l: autre.lease.id } });

      const televerser = async (champs, nom = 'x.png') => {
        const req = api().post('/api/v1/documents').set(p.h);
        for (const [k, v] of Object.entries(champs)) req.field(k, String(v));
        const res = await req.attach('fichier', await pngTest('#123'), nom);
        expect(res.status).toBe(201);
        return res.body.data.document.id;
      };
      // Photo d'un immeuble (aucun locataire, invisible du locataire).
      const photoImmeuble = await televerser({ entity_type: 'building', entity_id: building.id, category: 'photo' });
      // Photo d'un AUTRE immeuble.
      const photoAutreImmeuble = await televerser({ entity_type: 'building', entity_id: autre.building.id, category: 'photo' });
      // Document du locataire, partagé, mais hors du dossier de la caution.
      const pieceLocataire = await televerser({ entity_type: 'tenant', entity_id: tenant.id, category: 'justificatif', visible_to_tenant: 'true' });
      // Justificatif de la caution d'un AUTRE bail.
      const autreJustificatif = await justificatif(p, autreCaution.id);

      for (const piece of [photoImmeuble, photoAutreImmeuble, pieceLocataire, autreJustificatif]) {
        const res = await retenir(p, depositId, 1000, [piece]);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('JUSTIFICATIF_INVALIDE');
      }
      // Un seul justificatif invalide suffit à tout refuser.
      const bon = await justificatif(p, depositId);
      expect((await retenir(p, depositId, 1000, [bon, photoImmeuble])).status).toBe(403);
      expect(await compter('deposit_transactions', "deposit_id = :id AND type = 'retenue'", { id: depositId })).toBe(0);
      expect((await retenir(p, depositId, 1000, [bon])).status).toBe(201);
    });

    test('AUDIT #6 : photo d’un état des lieux de sortie — refusée tant qu’il est brouillon (invisible), admise une fois soumis ; éléments d’un autre bail → 422', async () => {
      const { p, lease, depositId } = await dossier({ versee: true, terminee: true });
      const sortie = await api().post(EDL).set(p.h).send({ lease_id: lease.id, type: 'sortie' });
      expect(sortie.status).toBe(201);
      const item = sortie.body.data.inspection.rooms[0].items[0];
      const photo = await api().post(`${EDL}/${sortie.body.data.inspection.id}/elements/${item.id}/photos`).set(p.h).attach('fichier', await pngTest('#555'), 'mur.png');
      expect(photo.status).toBe(201);
      const photoId = photo.body.data.photo.document.id;

      const brouillon = await retenir(p, depositId, 50000, [photoId], { inspection_item_ids: [item.id] });
      expect(brouillon.status).toBe(403);
      expect(brouillon.body.error.code).toBe('JUSTIFICATIF_INVALIDE');

      expect((await api().post(`${EDL}/${sortie.body.data.inspection.id}/soumettre`).set(p.h).send({})).status).toBe(200);

      // Élément d'un état des lieux d'un AUTRE bail : refusé.
      const autre = await dossier({ terminee: true });
      const autreEdl = await api().post(EDL).set(autre.p.h).send({ lease_id: autre.lease.id, type: 'sortie' });
      const autreItem = autreEdl.body.data.inspection.rooms[0].items[0].id;
      const etranger = await retenir(p, depositId, 50000, [photoId], { inspection_item_ids: [item.id, autreItem] });
      expect(etranger.status).toBe(422);
      expect(etranger.body.error.code).toBe('ELEMENT_ETRANGER');
      const invente = await retenir(p, depositId, 50000, [photoId], { inspection_item_ids: [UUID_INCONNU] });
      expect(invente.status).toBe(422);

      const ok = await retenir(p, depositId, 50000, [photoId], { inspection_item_ids: [item.id] });
      expect(ok.status).toBe(201);
      expect(ok.body.data.transaction).toMatchObject({ type: 'retenue', amount: 50000, inspection_item_ids: [item.id], justification_document_ids: [photoId] });
    });

    test('retenue valide : statut retenue_partielle, audit, notification ; retenue intégrale → solde nul', async () => {
      const { p, locataire, depositId } = await dossier({ versee: true, terminee: true });
      expect((await ligneCaution(depositId)).status).toBe('restitution_en_cours');
      const j = await justificatif(p, depositId);
      const r = await retenir(p, depositId, 200000, [j], { reason: 'loyer_impaye', occurred_on: '2026-12-01' });
      expect(r.status).toBe(201);
      expect(r.body.data.deposit).toMatchObject({ status: 'retenue_partielle', amount_withheld: 200000 });
      expect(r.body.data.transaction).toMatchObject({ reason: 'loyer_impaye', occurred_on: '2026-12-01', contest_status: null });
      expect(await compter('audit_logs', "action = 'caution.retenue' AND entity_id = :id", { id: depositId })).toBe(1);
      expect(await compter('notifications', "user_id = :u AND type = 'caution' AND title = 'Retenue sur votre caution'", { u: locataire.user.id })).toBe(1);
      // Aucune écriture de caisse : une retenue n'est pas un encaissement.
      expect(await compter('cash_movements', "source_type = 'deposit_transaction' AND source_id = :id", { id: r.body.data.transaction.id })).toBe(0);

      const reste = await retenir(p, depositId, 500000, [j], { reason: 'charges' });
      expect(reste.body.data.deposit).toMatchObject({ status: 'retenue_partielle', amount_withheld: 700000 });
      expect((await api().get(`${BASE}/${depositId}`).set(p.h)).body.data.deposit.balance).toBe(0);
      expect((await retenir(p, depositId, 1, [j])).status).toBe(422);
    });
  });

  describe('restitution', () => {
    test('pendant le bail → 409 ; au-delà du solde → 422 ; validation', async () => {
      const actif = await dossier({ versee: true });
      expect((await restituer(actif.p, actif.depositId, 1000)).body.error.code).toBe('BAIL_NON_TERMINE');
      const { p, depositId } = await dossier({ versee: true, terminee: true });
      const u = `${BASE}/${depositId}/restitutions`;
      const ecarts = await verifierStatuts([
        ['post', u, {}, 422],
        ['post', u, { amount: 700001, occurred_on: '2026-12-01', method: 'especes' }, 422],
        ['post', u, { amount: 0, occurred_on: '2026-12-01', method: 'especes' }, 422],
        ['post', u, { amount: 100, occurred_on: 'hier', method: 'especes' }, 422],
        ['post', u, { amount: 100, occurred_on: '2026-12-01', method: 'troc' }, 422],
      ], p.h);
      expect(ecarts).toEqual([]);
      expect((await restituer(p, depositId, 700001)).body.error.code).toBe('RESTITUTION_SUPERIEURE_AU_SOLDE');
    });

    test('restitution partielle puis du solde : statut restituee, caisse sortie is_deposit, reçu, notification, clôture possible', async () => {
      const { p, locataire, lease, depositId } = await dossier({ versee: true, terminee: true });
      const r1 = await restituer(p, depositId, 300000);
      expect(r1.status).toBe(201);
      expect(r1.body.data.deposit.status).toBe('restitution_en_cours');
      expect((await api().post(`/api/v1/baux/${lease.id}/cloturer`).set(p.h).send({})).body.error.code).toBe('CAUTION_NON_SOLDEE');
      const r2 = await restituer(p, depositId, 400000);
      expect(r2.body.data.deposit).toMatchObject({ status: 'restituee', amount_refunded: 700000 });
      expect((await ligneCaution(depositId)).settled_at).not.toBeNull();
      const [mv] = await sequelize.query(
        "SELECT direction, is_deposit, sum(amount)::int AS total FROM cash_movements WHERE owner_id = :o AND category = 'caution' GROUP BY direction, is_deposit ORDER BY direction",
        { replacements: { o: p.ownerId } }
      );
      expect(mv).toEqual([{ direction: 'entree', is_deposit: true, total: 700000 }, { direction: 'sortie', is_deposit: true, total: 700000 }]);
      expect(await compter('deposit_transactions', "deposit_id = :id AND type = 'restitution' AND receipt_document_id IS NOT NULL", { id: depositId })).toBe(2);
      expect(await compter('notifications', "user_id = :u AND title = 'Restitution de caution'", { u: locataire.user.id })).toBe(2);
      expect(await compter('audit_logs', "action = 'caution.restitution' AND entity_id = :id", { id: depositId })).toBe(2);
      expect((await restituer(p, depositId, 1)).status).toBe(422);
      expect((await api().post(`/api/v1/baux/${lease.id}/cloturer`).set(p.h).send({})).status).toBe(200);
    });
  });

  describe('contestation (§ 55.3) et litige', () => {
    async function retenueContestable() {
      const d = await dossier({ versee: true, terminee: true });
      const j = await justificatif(d.p, d.depositId);
      const r = await retenir(d.p, d.depositId, 100000, [j]);
      expect(r.status).toBe(201);
      return { ...d, retenueId: r.body.data.transaction.id };
    }
    const contester = (loc, id, message = 'La porte était déjà abîmée à mon arrivée.') => api().post(`${LOC}/retenues/${id}/contester`).set(loc.h).send({ message });
    const repondre = (p, depositId, id, corps) => api().post(`${BASE}/${depositId}/retenues/${id}/reponse`).set(p.h).send(corps);

    test('contestation : litige, notification au propriétaire, audit ; double contestation 409 ; validation', async () => {
      const { p, locataire, depositId, retenueId } = await retenueContestable();
      expect((await contester(locataire, retenueId, 'court')).status).toBe(422);
      expect((await contester(locataire, 'pas-un-uuid')).status).toBe(422);
      expect((await contester(locataire, UUID_INCONNU)).status).toBe(422);
      const res = await contester(locataire, retenueId);
      expect(res.status).toBe(200);
      expect(res.body.data.deposit.status).toBe('litige');
      expect(res.body.data.transaction).toMatchObject({ contest_status: 'conteste', contest_message: 'La porte était déjà abîmée à mon arrivée.' });
      expect(await compter('notifications', "user_id = :u AND title = 'Retenue contestée'", { u: p.user.id })).toBe(1);
      expect(await compter('audit_logs', "action = 'caution.contestation' AND entity_id = :id", { id: depositId })).toBe(1);
      const deux = await contester(locataire, retenueId);
      expect(deux.status).toBe(409);
      expect(deux.body.error.code).toBe('DEJA_CONTESTEE');
      // Un versement ne se conteste pas.
      const [[versement]] = await sequelize.query("SELECT id FROM deposit_transactions WHERE deposit_id = :id AND type = 'versement'", { replacements: { id: depositId } });
      expect((await contester(locataire, versement.id)).body.error.code).toBe('CONTESTATION_IMPOSSIBLE');
    });

    test('issue « maintenue » : litige documenté, le bail peut être clos (§ 55.4)', async () => {
      const { p, locataire, lease, depositId, retenueId } = await retenueContestable();
      expect((await repondre(p, depositId, retenueId, { response: 'Rien à redire.', outcome: 'maintenue' })).body.error.code).toBe('CONTESTATION_ABSENTE');
      await contester(locataire, retenueId);
      expect((await api().post(`/api/v1/baux/${lease.id}/cloturer`).set(p.h).send({})).body.error.code).toBe('CAUTION_NON_SOLDEE');
      const rep = await repondre(p, depositId, retenueId, { response: 'Photos de sortie à l’appui.', outcome: 'maintenue' });
      expect(rep.status).toBe(200);
      expect(rep.body.data.deposit).toMatchObject({ status: 'litige', amount_withheld: 100000 });
      expect(rep.body.data.transaction).toMatchObject({ contest_status: 'maintenue', owner_response: 'Photos de sortie à l’appui.', adjusted_amount: null });
      expect(await compter('notifications', "user_id = :u AND title = 'Réponse à votre contestation'", { u: locataire.user.id })).toBe(1);
      expect(await compter('audit_logs', "action = 'caution.reponse_contestation' AND entity_id = :id", { id: depositId })).toBe(1);
      expect((await repondre(p, depositId, retenueId, { response: 'Encore une fois.', outcome: 'annulee' })).status).toBe(409);
      expect((await api().post(`/api/v1/baux/${lease.id}/cloturer`).set(p.h).send({})).status).toBe(200);
    });

    test('issue « annulée » : retenue sans effet, solde rétabli ; issue « ajustée » : montant réduit ; validation', async () => {
      const a = await retenueContestable();
      await contester(a.locataire, a.retenueId);
      const annulee = await repondre(a.p, a.depositId, a.retenueId, { response: 'Vous avez raison, désolé.', outcome: 'annulee' });
      expect(annulee.status).toBe(200);
      expect(annulee.body.data.deposit).toMatchObject({ amount_withheld: 0, status: 'restitution_en_cours' });

      const b = await retenueContestable();
      await contester(b.locataire, b.retenueId);
      const u = `${BASE}/${b.depositId}/retenues/${b.retenueId}/reponse`;
      const ecarts = await verifierStatuts([
        ['post', u, { response: 'Ajustement', outcome: 'ajustee' }, 422],
        ['post', u, { response: 'Ajustement', outcome: 'ajustee', adjusted_amount: 100000 }, 422],
        ['post', u, { response: 'Ajustement', outcome: 'ajustee', adjusted_amount: 150000 }, 422],
        ['post', u, { response: 'Ajustement', outcome: 'ajustee', adjusted_amount: -1 }, 422],
        ['post', u, { response: 'Maintien', outcome: 'maintenue', adjusted_amount: 5 }, 422],
        ['post', u, { response: 'Ok', outcome: 'maintenue' }, 422],
        ['post', u, { response: 'Décision prise', outcome: 'partagee' }, 422],
        ['post', `${BASE}/${b.depositId}/retenues/${a.retenueId}/reponse`, { response: 'Mauvaise caution', outcome: 'annulee' }, 422],
        ['post', `${BASE}/${b.depositId}/retenues/pas-un-uuid/reponse`, { response: 'Décision prise', outcome: 'annulee' }, 422],
      ], b.p.h);
      expect(ecarts).toEqual([]);
      const ajustee = await repondre(b.p, b.depositId, b.retenueId, { response: 'Je réduis la retenue.', outcome: 'ajustee', adjusted_amount: 40000 });
      expect(ajustee.status).toBe(200);
      expect(ajustee.body.data.deposit).toMatchObject({ amount_withheld: 40000, status: 'retenue_partielle' });
      expect(ajustee.body.data.transaction).toMatchObject({ contest_status: 'ajustee', adjusted_amount: 40000 });
      // Le solde se restitue ensuite intégralement.
      expect((await restituer(b.p, b.depositId, 660000)).body.data.deposit.status).toBe('restituee');
    });

    test('isolation : un autre locataire ne voit ni ne conteste ; le propriétaire n’entre pas dans l’espace locataire', async () => {
      const { p, locataire, depositId, retenueId } = await retenueContestable();
      const intrus = await proprietaireEtLocataire();
      const vue = await api().get(LOC).set(locataire.h);
      expect(vue.status).toBe(200);
      expect(vue.body.data.deposits.map((d) => d.id)).toEqual([depositId]);
      expect(vue.body.data.deposits[0]).toMatchObject({ balance: 600000, amount_withheld: 100000 });
      expect(vue.body.data.deposits[0].transactions.map((t) => t.type)).toEqual(['versement', 'retenue']);
      expect(vue.body.data.deposits[0]).not.toHaveProperty('tenant');
      expect((await api().get(LOC).set(intrus.locataire.h)).body.data.deposits.map((d) => d.id)).not.toContain(depositId);
      const refus = await contester(intrus.locataire, retenueId);
      expect(refus.status).toBe(403);
      expect((await ligneCaution(depositId)).status).toBe('retenue_partielle');
      expect((await api().get(LOC).set(p.h)).status).toBe(403);
      expect((await api().post(`${LOC}/retenues/${retenueId}/contester`).set(p.h).send({ message: 'Je suis le propriétaire, pas le locataire.' })).status).toBe(403);
      expect((await api().get(BASE).set(locataire.h)).status).toBe(403);
      expect((await api().get(`${BASE}/${depositId}`).set(locataire.h)).status).toBe(403);
    });
  });

  describe('concurrence et verrous', () => {
    test('deux versements simultanés dépassant la caution : un seul passe, jamais plus que le montant prévu', async () => {
      for (let i = 0; i < 3; i += 1) {
        const { p, depositId } = await dossier();
        const reponses = await Promise.all([verser(p, depositId, 400000), verser(p, depositId, 400000)]);
        expect(reponses.map((r) => r.status).sort()).toEqual([201, 422]);
        const d = await ligneCaution(depositId);
        expect(d.amount_received).toBe(400000);
        expect(await compter('cash_movements', "owner_id = :o AND category = 'caution'", { o: p.ownerId })).toBe(1);
      }
    });

    test('restitutions simultanées : le solde n’est jamais négatif', async () => {
      const { p, depositId } = await dossier({ versee: true, terminee: true });
      const reponses = await Promise.all([1, 2, 3].map(() => restituer(p, depositId, 300000)));
      expect(reponses.map((r) => r.status).sort()).toEqual([201, 201, 422]);
      const d = await ligneCaution(depositId);
      expect(d.amount_refunded).toBe(600000);
      expect(d.amount_received - d.amount_withheld - d.amount_refunded).toBe(100000);
    });

    test('AUDIT #21 : la contestation verrouille la CAUTION avant la retenue (même ordre que la réponse du propriétaire)', async () => {
      const d = await dossier({ versee: true, terminee: true });
      const j = await justificatif(d.p, d.depositId);
      const r = await retenir(d.p, d.depositId, 1000, [j]);
      const verrous = [];
      const journal = sequelize.options.logging;
      sequelize.options.logging = (sql) => {
        if (/FOR UPDATE/.test(sql)) verrous.push(/FROM "deposit_transactions"/.test(sql) ? 'retenue' : /FROM "deposits"/.test(sql) ? 'caution' : 'autre');
      };
      try {
        const res = await api().post(`${LOC}/retenues/${r.body.data.transaction.id}/contester`).set(d.locataire.h).send({ message: 'Je conteste cette retenue injustifiée.' });
        expect(res.status).toBe(200);
      } finally {
        sequelize.options.logging = journal;
      }
      expect(verrous.slice(0, 2)).toEqual(['caution', 'retenue']);
    });

    test('AUDIT #21 : contestation et réponse simultanées, répétées : jamais d’interblocage (ni 503 ni 500), état cohérent', async () => {
      const d = await dossier({ versee: true, terminee: true });
      const j = await justificatif(d.p, d.depositId);
      for (let i = 0; i < 6; i += 1) {
        const r = await retenir(d.p, d.depositId, 1000, [j]);
        const id = r.body.data.transaction.id;
        const [contestation, reponse] = await Promise.all([
          api().post(`${LOC}/retenues/${id}/contester`).set(d.locataire.h).send({ message: 'Je conteste cette retenue injustifiée.' }),
          api().post(`${BASE}/${d.depositId}/retenues/${id}/reponse`).set(d.p.h).send({ response: 'Retenue maintenue.', outcome: 'maintenue' }),
        ]);
        expect(contestation.status).toBe(200);
        expect([200, 409]).toContain(reponse.status);
        const [[tr]] = await sequelize.query('SELECT contest_status FROM deposit_transactions WHERE id = :id', { replacements: { id } });
        expect(tr.contest_status).toBe(reponse.status === 200 ? 'maintenue' : 'conteste');
        if (reponse.status === 409) {
          expect((await api().post(`${BASE}/${d.depositId}/retenues/${id}/reponse`).set(d.p.h).send({ response: 'Retenue maintenue.', outcome: 'maintenue' })).status).toBe(200);
        }
      }
      expect((await ligneCaution(d.depositId)).status).toBe('litige');
    });
  });

  describe('sécurité', () => {
    let routesProprio; let routesLoc;

    beforeAll(async () => {
      const d = await dossier();
      routesProprio = [
        ['get', BASE], ['get', `${BASE}/${d.depositId}`], ['post', `${BASE}/${d.depositId}/versements`],
        ['post', `${BASE}/${d.depositId}/justificatifs`], ['post', `${BASE}/${d.depositId}/retenues`],
        ['post', `${BASE}/${d.depositId}/restitutions`], ['post', `${BASE}/${d.depositId}/retenues/${UUID_INCONNU}/reponse`],
      ];
      routesLoc = [['get', LOC], ['post', `${LOC}/retenues/${UUID_INCONNU}/contester`]];
    });

    test('authentification refusée (401 / 403 compte désactivé) sur toutes les routes', async () => {
      expect(await verifierMatrice(routesProprio, await jetonsDegrades('proprietaire'))).toEqual([]);
      expect(await verifierMatrice(routesLoc, await jetonsDegrades('locataire'))).toEqual([]);
    });

    test('autre propriétaire → 403 et caution inchangée ; super admin, locataire, sans permission → 403', async () => {
      const d = await dossier({ versee: true, terminee: true });
      const autre = await nouveauProprietaire();
      const admin = await superAdmin();
      const sansDroit = await proprietaireSansPermission();
      const avant = await ligneCaution(d.depositId);
      const routes = [
        ['get', `${BASE}/${d.depositId}`, undefined],
        ['post', `${BASE}/${d.depositId}/versements`, { amount: 1, occurred_on: '2026-09-01', method: 'especes' }],
        ['post', `${BASE}/${d.depositId}/retenues`, { amount: 1, reason: 'autre', description: 'Tentative', justification_document_ids: [UUID_INCONNU] }],
        ['post', `${BASE}/${d.depositId}/restitutions`, { amount: 1, occurred_on: '2026-12-01', method: 'especes' }],
        ['post', `${BASE}/${d.depositId}/retenues/${UUID_INCONNU}/reponse`, { response: 'Tentative', outcome: 'annulee' }],
      ];
      for (const h of [autre.h, admin.h, d.locataire.h, sansDroit.h]) {
        expect(await verifierStatuts(routes.map(([m, u, c]) => [m, u, c, 403]), h)).toEqual([]);
        expect((await api().post(`${BASE}/${d.depositId}/justificatifs`).set(h).attach('fichier', await pngTest(), 'x.png')).status).toBe(403);
      }
      expect(await verifierStatuts([['get', BASE, undefined, 403]], sansDroit.h)).toEqual([]);
      expect(await ligneCaution(d.depositId)).toEqual(avant);
      expect(await compter('documents', "entity_type = 'deposit' AND entity_id = :id AND category = 'justificatif'", { id: d.depositId })).toBe(0);
    });
  });
});
