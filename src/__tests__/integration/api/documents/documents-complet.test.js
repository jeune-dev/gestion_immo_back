'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  api, nouveauProprietaire, superAdmin, bailActif, activerLocataire, proprietaireEtLocataire, pngTest,
  expirerAbonnement, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const storage = require('../../../../infrastructure/storage.service.js');
const documents = require('../../../../modules/document/service/document.service.js');
const { transactionAvecFichiers } = require('../../../../database/transaction.js');
const {
  UUID_INCONNU, jetonsDegrades, verifierMatrice, verifierStatuts, proprietaireSansPermission,
} = require('../baux/securite.outils.js');

/**
 * Documents — toutes les routes /documents : téléversement manuel, liste,
 * flux, lien, partage, suppression. Couvre l'AUDIT #5 (une pièce probante ne
 * peut pas être retirée au locataire ; la visibilité d'une pièce produite par
 * un module ne se change pas ici), l'isolation des locataires, la validation
 * des fichiers par signature binaire et l'absence d'orphelin après un refus.
 */

const BASE = '/api/v1/documents';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n');

function televerser(proprio, champs, contenu = PDF, nom = 'piece.pdf') {
  const req = api().post(BASE).set(proprio.h);
  for (const [cle, valeur] of Object.entries(champs)) if (valeur !== undefined) req.field(cle, String(valeur));
  return req.attach('fichier', contenu, nom);
}

const fichiersDe = (ownerId) => {
  const dossier = path.join(storage.UPLOAD_DIR, 'owners', ownerId);
  return fs.existsSync(dossier) ? fs.readdirSync(dossier, { recursive: true }).filter((f) => fs.statSync(path.join(dossier, f)).isFile()) : [];
};

/** Document produit par un MODULE (et non téléversé à la main), comme le ferait ce module. */
async function documentDeModule(ownerId, tenantId, entityType, category, visible = true) {
  return transactionAvecFichiers((t) => documents.creerDocument({
    ownerId, tenantId, entityType, entityId: crypto.randomUUID(), category,
    fichier: { buffer: PDF, type: 'pdf', mime: 'application/pdf', nomOrigine: `${category}.pdf` }, visibleToTenant: visible,
  }, t));
}

describe('Documents — API complète', () => {
  afterAll(fermer);

  describe('POST /documents', () => {
    test('chaque ressource manuelle : 201, locataire concerné déduit, audit, fichier stocké, miniature des images', async () => {
      const { proprio: p, lease, building, apartment, tenant } = await proprietaireEtLocataire();
      const artisan = await api().post('/api/v1/artisans').set(p.h).send({ name: 'Ousmane Fall', trade: 'plombier' });
      expect(artisan.status).toBe(201);
      const cas = [
        ['building', building.id, 'photo', null],
        ['apartment', apartment.id, 'photo', null],
        ['tenant', tenant.id, 'piece_identite', tenant.id],
        ['lease', lease.id, 'contrat', tenant.id],
        ['contractor', artisan.body.data.contractor.id, 'justificatif', null],
      ];
      for (const [type, id, categorie, locataire] of cas) {
        const res = await televerser(p, { entity_type: type, entity_id: id, category: categorie }, await pngTest(), `${type}.png`);
        expect(res.status).toBe(201);
        const doc = res.body.data.document;
        expect(doc).toMatchObject({ category: categorie, mime_type: 'image/png', has_thumbnail: true, visible_to_tenant: false, url: `/api/v1/documents/${doc.id}/fichier` });
        expect(Object.keys(doc).sort()).toEqual(['captured_at', 'category', 'created_at', 'has_thumbnail', 'id', 'mime_type', 'original_name', 'size_bytes', 'url', 'visible_to_tenant']);
        const [[ligne]] = await sequelize.query('SELECT owner_id, tenant_id, entity_type, entity_id, storage_key, thumbnail_key, checksum, uploaded_by FROM documents WHERE id = :id', { replacements: { id: doc.id } });
        expect(ligne).toMatchObject({ owner_id: p.ownerId, tenant_id: locataire, entity_type: type, entity_id: id, uploaded_by: p.user.id });
        expect(ligne.checksum).toMatch(/^[0-9a-f]{64}$/);
        for (const cle of [ligne.storage_key, ligne.thumbnail_key]) expect(fs.existsSync(path.join(storage.UPLOAD_DIR, ...cle.split('/')))).toBe(true);
        expect(await compter('audit_logs', 'action = :a AND entity_id = :id', { a: `${type}.ajout_document`, id })).toBeGreaterThanOrEqual(1);
      }
    });

    test('validation des champs → 422, sans ligne ni fichier', async () => {
      const { proprio: p, building, tenant } = await proprietaireEtLocataire();
      const avant = fichiersDe(p.ownerId).length;
      const png = await pngTest();
      const cas = [
        [{ entity_id: building.id, category: 'photo' }],
        [{ entity_type: 'building', category: 'photo' }],
        [{ entity_type: 'building', entity_id: building.id }],
        [{ entity_type: 'inspection', entity_id: building.id, category: 'photo' }],
        [{ entity_type: 'deposit', entity_id: building.id, category: 'photo' }],
        [{ entity_type: 'building', entity_id: 'pas-un-uuid', category: 'photo' }],
        [{ entity_type: 'building', entity_id: building.id, category: 'recu' }],
        [{ entity_type: 'building', entity_id: building.id, category: 'etat_des_lieux' }],
        [{ entity_type: 'building', entity_id: building.id, category: 'photo', captured_at: 'hier soir' }],
        [{ entity_type: 'tenant', entity_id: tenant.id, category: 'photo', visible_to_tenant: 'peut-etre' }],
        [{ entity_type: 'apartment', entity_id: UUID_INCONNU, category: 'photo' }, 404],
      ];
      for (const [champs, statut = 422] of cas) {
        const res = await televerser(p, champs, png, 'x.png');
        expect(`${JSON.stringify(champs)} → ${res.status}`).toBe(`${JSON.stringify(champs)} → ${statut}`);
      }
      expect(await compter('documents', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect(fichiersDe(p.ownerId)).toHaveLength(avant);
    });

    test('fichier : signature binaire vérifiée (texte, exécutable, vidéo refusés), taille plafonnée, absent → 400 ; aucun orphelin', async () => {
      const { proprio: p, building } = await proprietaireEtLocataire();
      const champs = { entity_type: 'building', entity_id: building.id, category: 'photo' };
      const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 0x90)]);
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
      const html = Buffer.from('<html><script>alert(1)</script></html>');
      for (const [contenu, nom] of [[Buffer.from('juste du texte, pas un PDF'), 'faux.pdf'], [exe, 'photo.png'], [mp4, 'video.png'], [html, 'page.pdf']]) {
        const res = await televerser(p, champs, contenu, nom);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('FORMAT_FICHIER_REFUSE');
      }
      const gros = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(10.5 * 1024 * 1024)]);
      const tropGros = await televerser(p, champs, gros, 'enorme.png');
      expect(tropGros.status).toBe(400);
      expect(tropGros.body.error.code).toBe('FICHIER_TROP_VOLUMINEUX');
      const sansFichier = await api().post(BASE).set(p.h).field('entity_type', 'building').field('entity_id', building.id).field('category', 'photo');
      expect(sansFichier.status).toBe(400);
      expect(sansFichier.body.error.code).toBe('FICHIER_MANQUANT');
      expect(await compter('documents', 'owner_id = :o', { o: p.ownerId })).toBe(0);
      expect(fichiersDe(p.ownerId)).toEqual([]);
    });

    test('partage direct : notifie le locataire ; document sans locataire non partageable (422) ; idempotence', async () => {
      const { proprio: p, locataire, tenant, building } = await proprietaireEtLocataire();
      const res = await televerser(p, { entity_type: 'tenant', entity_id: tenant.id, category: 'autre', visible_to_tenant: 'true' });
      expect(res.status).toBe(201);
      expect(await compter('notifications', "user_id = :u AND type = 'document_disponible'", { u: locataire.user.id })).toBe(1);
      expect((await televerser(p, { entity_type: 'building', entity_id: building.id, category: 'autre', visible_to_tenant: 'true' })).status).toBe(422);

      const cle = `doc-${tenant.id.slice(0, 8)}`;
      const envoi = () => api().post(BASE).set(p.h).set('Idempotency-Key', cle)
        .field('entity_type', 'building').field('entity_id', building.id).field('category', 'autre').attach('fichier', PDF, 'a.pdf');
      const [a, b] = [await envoi(), await envoi()];
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.data.document.id).toBe(a.body.data.document.id);
      expect(await compter('documents', "entity_type = 'building' AND entity_id = :b", { b: building.id })).toBe(1);
    });
  });

  describe('GET /documents', () => {
    test('liste vide, pagination (pages, au-delà, plafond 100), tri récents d’abord, totaux exacts ; 422 sur paramètres invalides', async () => {
      const { proprio: p, building } = await proprietaireEtLocataire();
      expect((await api().get(BASE).set(p.h)).body.data).toEqual({ items: [], pagination: expect.objectContaining({ total: 0 }) });
      const ids = [];
      for (let i = 0; i < 3; i += 1) ids.push((await televerser(p, { entity_type: 'building', entity_id: building.id, category: 'autre' })).body.data.document.id);
      const p1 = await api().get(`${BASE}?limit=2`).set(p.h);
      expect(p1.body.data.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(p1.body.data.items.map((d) => d.id)).toEqual([ids[2], ids[1]]);
      expect((await api().get(`${BASE}?limit=2&page=2`).set(p.h)).body.data.items.map((d) => d.id)).toEqual([ids[0]]);
      expect((await api().get(`${BASE}?limit=2&page=5`).set(p.h)).body.data.items).toEqual([]);
      expect((await api().get(`${BASE}?limit=1000`).set(p.h)).body.data.pagination.limit).toBe(100);
      const filtre = await api().get(`${BASE}?entity_type=building&entity_id=${building.id}`).set(p.h);
      expect(filtre.body.data.pagination.total).toBe(3);
      expect((await api().get(`${BASE}?entity_type=apartment&entity_id=${building.id}`).set(p.h)).status).toBe(404);
      const ecarts = await verifierStatuts([
        ['get', `${BASE}?page=0`, undefined, 422],
        ['get', `${BASE}?page=-1`, undefined, 422],
        ['get', `${BASE}?limit=0`, undefined, 422],
        ['get', `${BASE}?entity_type=building`, undefined, 422],
        ['get', `${BASE}?entity_id=${building.id}`, undefined, 422],
        ['get', `${BASE}?entity_type=planete&entity_id=${building.id}`, undefined, 422],
        ['get', `${BASE}?entity_type=building&entity_id=${encodeURIComponent("x' OR 1=1")}`, undefined, 422],
      ], p.h);
      expect(ecarts).toEqual([]);
    });

    test('locataire : uniquement SES documents partagés — jamais ceux d’un autre locataire, même partagés, ni les non partagés', async () => {
      const a = await proprietaireEtLocataire();
      const b = await proprietaireEtLocataire();
      // Même propriétaire, autre locataire : son document partagé reste invisible pour A.
      const voisin = await bailActif(a.proprio);
      const locVoisin = await activerLocataire(a.proprio, voisin.tenant);
      const partageA = (await televerser(a.proprio, { entity_type: 'lease', entity_id: a.lease.id, category: 'autre', visible_to_tenant: 'true' })).body.data.document.id;
      const priveA = (await televerser(a.proprio, { entity_type: 'lease', entity_id: a.lease.id, category: 'autre' })).body.data.document.id;
      const partageVoisin = (await televerser(a.proprio, { entity_type: 'lease', entity_id: voisin.lease.id, category: 'autre', visible_to_tenant: 'true' })).body.data.document.id;
      const partageB = (await televerser(b.proprio, { entity_type: 'lease', entity_id: b.lease.id, category: 'autre', visible_to_tenant: 'true' })).body.data.document.id;

      const liste = await api().get(BASE).set(a.locataire.h);
      expect(liste.status).toBe(200);
      expect(liste.body.data.items.map((d) => d.id)).toEqual([partageA]);
      expect(liste.body.data.pagination.total).toBe(1);
      // Désigner la ressource d'autrui ne révèle rien.
      expect((await api().get(`${BASE}?entity_type=lease&entity_id=${voisin.lease.id}`).set(a.locataire.h)).body.data.items).toEqual([]);
      expect((await api().get(`${BASE}?entity_type=lease&entity_id=${b.lease.id}`).set(a.locataire.h)).body.data.items).toEqual([]);
      for (const id of [priveA, partageVoisin, partageB]) {
        expect((await api().get(`${BASE}/${id}/fichier`).set(a.locataire.h)).status).toBe(403);
        expect((await api().get(`${BASE}/${id}/lien`).set(a.locataire.h)).status).toBe(403);
      }
      expect((await api().get(`${BASE}/${partageVoisin}/fichier`).set(locVoisin.h)).status).toBe(200);
      expect((await api().get(`${BASE}/${partageA}/lien`).set(a.locataire.h)).body.data).toEqual({ url: `/api/v1/documents/${partageA}/fichier`, expires_in: null });
    });

    test('AUDIT #15 : les photos d’un état des lieux BROUILLON ne sont ni listées ni lisibles par le locataire ; elles le deviennent à la soumission', async () => {
      const { proprio: p, locataire, lease } = await proprietaireEtLocataire();
      const edl = await api().post('/api/v1/etats-des-lieux').set(p.h).send({ lease_id: lease.id, type: 'sortie' });
      const inspection = edl.body.data.inspection;
      const item = inspection.rooms[0].items[0];
      const photo = await api().post(`/api/v1/etats-des-lieux/${inspection.id}/elements/${item.id}/photos`).set(p.h).attach('fichier', await pngTest(), 'mur.png');
      const docId = photo.body.data.photo.document.id;
      expect(photo.body.data.photo.document.visible_to_tenant).toBe(false);
      expect((await api().get(BASE).set(locataire.h)).body.data.items.map((d) => d.id)).not.toContain(docId);
      expect((await api().get(`${BASE}?entity_type=inspection&entity_id=${inspection.id}`).set(locataire.h)).body.data.items).toEqual([]);
      expect((await api().get(`${BASE}/${docId}/fichier`).set(locataire.h)).status).toBe(403);
      // Le propriétaire ne peut pas contourner la règle en partageant la photo à la main.
      const contournement = await api().patch(`${BASE}/${docId}`).set(p.h).send({ visible_to_tenant: true });
      expect(contournement.status).toBe(409);
      expect(contournement.body.error.code).toBe('DOCUMENT_PROTEGE');

      expect((await api().post(`/api/v1/etats-des-lieux/${inspection.id}/soumettre`).set(p.h).send({})).status).toBe(200);
      expect((await api().get(`${BASE}?entity_type=inspection&entity_id=${inspection.id}`).set(locataire.h)).body.data.items.map((d) => d.id)).toEqual([docId]);
      expect((await api().get(`${BASE}/${docId}/fichier`).set(locataire.h)).status).toBe(200);
    });
  });

  describe('GET /documents/:id/fichier et /lien', () => {
    test('flux : octets et en-têtes ; miniature ; taille invalide 422 ; inconnu 404 ; identifiant invalide 422', async () => {
      const { proprio: p, building } = await proprietaireEtLocataire();
      const png = await pngTest('#abc');
      const doc = (await televerser(p, { entity_type: 'building', entity_id: building.id, category: 'photo' }, png, 'façade.png')).body.data.document;
      const flux = await api().get(`${BASE}/${doc.id}/fichier`).set(p.h).buffer(true).parse((res, cb) => {
        const m = []; res.on('data', (x) => m.push(x)); res.on('end', () => cb(null, Buffer.concat(m)));
      });
      expect(flux.status).toBe(200);
      expect(flux.headers['content-type']).toBe('image/png');
      expect(flux.headers['cache-control']).toBe('private, no-store');
      expect(flux.headers['content-disposition']).toContain("filename*=UTF-8''fa%C3%A7ade.png");
      expect(flux.body.subarray(0, 4).toString('hex')).toBe('89504e47');
      expect((await api().get(`${BASE}/${doc.id}/fichier?taille=miniature`).set(p.h)).headers['content-type']).toBe('image/webp');
      expect((await api().get(`${BASE}/${doc.id}/lien?taille=miniature`).set(p.h)).body.data.url).toBe(`/api/v1/documents/${doc.id}/fichier?taille=miniature`);
      const ecarts = await verifierStatuts([
        ['get', `${BASE}/${doc.id}/fichier?taille=geante`, undefined, 422],
        ['get', `${BASE}/${doc.id}/lien?taille=geante`, undefined, 422],
        ['get', `${BASE}/${UUID_INCONNU}/fichier`, undefined, 404],
        ['get', `${BASE}/${UUID_INCONNU}/lien`, undefined, 404],
        ['get', `${BASE}/abc/fichier`, undefined, 422],
      ], p.h);
      expect(ecarts).toEqual([]);
    });
  });

  describe('PATCH /documents/:id — partage (AUDIT #5)', () => {
    test('document manuel : partage (notifié, audité) puis retrait autorisé pour une photo ; idempotent', async () => {
      const { proprio: p, locataire, lease } = await proprietaireEtLocataire();
      const id = (await televerser(p, { entity_type: 'lease', entity_id: lease.id, category: 'photo' }, await pngTest(), 'a.png')).body.data.document.id;
      const partage = await api().patch(`${BASE}/${id}`).set(p.h).send({ visible_to_tenant: true });
      expect(partage.status).toBe(200);
      expect(partage.body.data.document.visible_to_tenant).toBe(true);
      expect(await compter('notifications', "user_id = :u AND type = 'document_disponible' AND data->>'document_id' = :id", { u: locataire.user.id, id })).toBe(1);
      const encore = await api().patch(`${BASE}/${id}`).set(p.h).send({ visible_to_tenant: true });
      expect(encore.status).toBe(200);
      expect(await compter('notifications', "user_id = :u AND data->>'document_id' = :id", { u: locataire.user.id, id })).toBe(1);
      const retrait = await api().patch(`${BASE}/${id}`).set(p.h).send({ visible_to_tenant: false });
      expect(retrait.status).toBe(200);
      expect(retrait.body.data.document.visible_to_tenant).toBe(false);
      expect(await compter('audit_logs', "action = 'document.modification' AND entity_id = :id", { id })).toBe(2);
    });

    test('pièce probante partagée (contrat manuel) : le partage ne peut pas être retiré → 409 DOCUMENT_PROTEGE', async () => {
      const { proprio: p, locataire, lease } = await proprietaireEtLocataire();
      const id = (await televerser(p, { entity_type: 'lease', entity_id: lease.id, category: 'contrat', visible_to_tenant: 'true' })).body.data.document.id;
      const res = await api().patch(`${BASE}/${id}`).set(p.h).send({ visible_to_tenant: false });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DOCUMENT_PROTEGE');
      const [[ligne]] = await sequelize.query('SELECT visible_to_tenant FROM documents WHERE id = :id', { replacements: { id } });
      expect(ligne.visible_to_tenant).toBe(true);
      expect((await api().get(`${BASE}/${id}/fichier`).set(locataire.h)).status).toBe(200);
    });

    test('pièces produites par un module (état des lieux accepté, reçu, preuve de paiement, quittance, justificatif de retenue, message…) : visibilité intouchable → 409', async () => {
      const { proprio: p, lease } = await proprietaireEtLocataire();
      const cas = [
        ['inspection', 'etat_des_lieux'], ['deposit', 'recu'], ['deposit', 'justificatif'], ['payment_transaction', 'preuve_paiement'],
        ['receipt', 'quittance'], ['message', 'photo'], ['incident', 'photo'], ['work_order', 'photo'], ['expense', 'facture'],
        ['charge_invoice', 'facture'],
      ];
      for (const [type, categorie] of cas) {
        const doc = await documentDeModule(p.ownerId, lease.tenant_id, type, categorie, true);
        const masquer = await api().patch(`${BASE}/${doc.id}`).set(p.h).send({ visible_to_tenant: false });
        expect(`${type}/${categorie} → ${masquer.status} ${masquer.body.error?.code}`).toBe(`${type}/${categorie} → 409 DOCUMENT_PROTEGE`);
        const cache = await documentDeModule(p.ownerId, lease.tenant_id, type, categorie, false);
        const montrer = await api().patch(`${BASE}/${cache.id}`).set(p.h).send({ visible_to_tenant: true });
        expect(`${type}/${categorie} → ${montrer.status}`).toBe(`${type}/${categorie} → 409`);
      }
      expect(await compter('documents', 'owner_id = :o AND visible_to_tenant = false', { o: p.ownerId })).toBe(cas.length);
      expect(await compter('audit_logs', "action = 'document.modification' AND owner_id = :o", { o: p.ownerId })).toBe(0);
    });

    test('état des lieux ACCEPTÉ : son PDF archivé ne peut être ni retiré au locataire ni supprimé', async () => {
      const { proprio: p, locataire, lease } = await proprietaireEtLocataire();
      const edl = (await api().post('/api/v1/etats-des-lieux').set(p.h).send({ lease_id: lease.id, type: 'sortie' })).body.data.inspection;
      await api().post(`/api/v1/etats-des-lieux/${edl.id}/soumettre`).set(p.h).send({});
      const accepte = await api().post(`/api/v1/locataire/etats-des-lieux/${edl.id}/accepter`).set(locataire.h).send({});
      expect(accepte.status).toBe(200);
      const pdfId = accepte.body.data.inspection.document_id;
      expect((await api().patch(`${BASE}/${pdfId}`).set(p.h).send({ visible_to_tenant: false })).body.error.code).toBe('DOCUMENT_PROTEGE');
      expect((await api().delete(`${BASE}/${pdfId}`).set(p.h)).body.error.code).toBe('DOCUMENT_PROTEGE');
      expect((await api().get(`${BASE}/${pdfId}/fichier`).set(locataire.h)).status).toBe(200);
    });

    test('validation : corps vide ou non booléen → 422 ; document sans locataire → 422 ; inconnu 404', async () => {
      const { proprio: p, building } = await proprietaireEtLocataire();
      const id = (await televerser(p, { entity_type: 'building', entity_id: building.id, category: 'photo' }, await pngTest(), 'b.png')).body.data.document.id;
      const ecarts = await verifierStatuts([
        ['patch', `${BASE}/${id}`, {}, 422],
        ['patch', `${BASE}/${id}`, { visible_to_tenant: 'oui' }, 422],
        ['patch', `${BASE}/${id}`, { visible_to_tenant: true }, 422],
        ['patch', `${BASE}/${UUID_INCONNU}`, { visible_to_tenant: true }, 404],
        ['patch', `${BASE}/zzz`, { visible_to_tenant: true }, 422],
      ], p.h);
      expect(ecarts).toEqual([]);
    });
  });

  describe('DELETE /documents/:id', () => {
    test('photo manuelle : suppression logique, objet conservé, audit ; seconde suppression 404', async () => {
      const { proprio: p, apartment } = await proprietaireEtLocataire();
      const id = (await televerser(p, { entity_type: 'apartment', entity_id: apartment.id, category: 'photo' }, await pngTest(), 's.png')).body.data.document.id;
      const [[{ storage_key: cle }]] = await sequelize.query('SELECT storage_key FROM documents WHERE id = :id', { replacements: { id } });
      const res = await api().delete(`${BASE}/${id}`).set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
      const [[ligne]] = await sequelize.query('SELECT deleted_at FROM documents WHERE id = :id', { replacements: { id } });
      expect(ligne.deleted_at).not.toBeNull();
      expect(fs.existsSync(path.join(storage.UPLOAD_DIR, ...cle.split('/')))).toBe(true);
      expect(await compter('audit_logs', "action = 'document.suppression' AND entity_id = :id", { id })).toBe(1);
      expect((await api().delete(`${BASE}/${id}`).set(p.h)).status).toBe(404);
      expect((await api().get(BASE).set(p.h)).body.data.items.map((d) => d.id)).not.toContain(id);
    });

    test('pièces probantes (catégorie protégée, pièce d’un module) → 409, jamais supprimées', async () => {
      const { proprio: p, lease } = await proprietaireEtLocataire();
      const contrat = (await televerser(p, { entity_type: 'lease', entity_id: lease.id, category: 'contrat' })).body.data.document.id;
      const recu = (await documentDeModule(p.ownerId, lease.tenant_id, 'deposit', 'recu')).id;
      const photoMessage = (await documentDeModule(p.ownerId, lease.tenant_id, 'message', 'photo')).id;
      for (const id of [contrat, recu, photoMessage]) {
        const res = await api().delete(`${BASE}/${id}`).set(p.h);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('DOCUMENT_PROTEGE');
      }
      expect(await compter('documents', 'id IN (:ids) AND deleted_at IS NULL', { ids: [contrat, recu, photoMessage] })).toBe(3);
    });
  });

  describe('sécurité', () => {
    test('authentification refusée sur toutes les routes (401 / 403 compte désactivé)', async () => {
      const { proprio: p, building } = await proprietaireEtLocataire();
      const id = (await televerser(p, { entity_type: 'building', entity_id: building.id, category: 'autre' })).body.data.document.id;
      const routes = [['post', BASE], ['get', BASE], ['get', `${BASE}/${id}/fichier`], ['get', `${BASE}/${id}/lien`], ['patch', `${BASE}/${id}`], ['delete', `${BASE}/${id}`]];
      expect(await verifierMatrice(routes, await jetonsDegrades('proprietaire'))).toEqual([]);
      expect(await verifierMatrice(routes, await jetonsDegrades('locataire'))).toEqual([]);
    });

    test('autre propriétaire, super admin, locataire (écriture), sans permission → 403 ; document inchangé', async () => {
      const { proprio: p, locataire, tenant, building } = await proprietaireEtLocataire();
      const id = (await televerser(p, { entity_type: 'tenant', entity_id: tenant.id, category: 'photo' }, await pngTest(), 'c.png')).body.data.document.id;
      const [avant] = await sequelize.query('SELECT visible_to_tenant, deleted_at, updated_at FROM documents WHERE id = :id', { replacements: { id } });
      const autre = await nouveauProprietaire();
      const admin = await superAdmin();
      const sansDroit = await proprietaireSansPermission();
      for (const [qui, h, lecture] of [['autre', autre.h, 403], ['admin', admin.h, 403], ['locataire', locataire.h, 403], ['sans permission', sansDroit.h, 403]]) {
        const ecarts = await verifierStatuts([
          ['get', `${BASE}/${id}/fichier`, undefined, lecture],
          ['get', `${BASE}/${id}/lien`, undefined, lecture],
          ['patch', `${BASE}/${id}`, { visible_to_tenant: true }, 403],
          ['delete', `${BASE}/${id}`, undefined, 403],
        ], h);
        expect(`${qui}: ${ecarts.join(' | ')}`).toBe(`${qui}: `);
        const envoi = await televerser({ h }, { entity_type: 'building', entity_id: building.id, category: 'photo' }, await pngTest(), 'x.png');
        expect(`${qui} POST → ${envoi.status}`).toBe(`${qui} POST → 403`);
      }
      expect((await api().get(`${BASE}?entity_type=tenant&entity_id=${tenant.id}`).set(autre.h)).status).toBe(403);
      expect((await api().get(BASE).set(sansDroit.h)).status).toBe(403);
      expect((await api().get(BASE).set(admin.h)).status).toBe(403);
      const [apres] = await sequelize.query('SELECT visible_to_tenant, deleted_at, updated_at FROM documents WHERE id = :id', { replacements: { id } });
      expect(apres).toEqual(avant);
      expect(await compter('documents', "owner_id <> :o AND entity_id = :b", { o: p.ownerId, b: building.id })).toBe(0);
    });

    test('abonnement échu : lecture possible, écriture 402', async () => {
      const { proprio: p, building } = await proprietaireEtLocataire();
      const id = (await televerser(p, { entity_type: 'building', entity_id: building.id, category: 'autre' })).body.data.document.id;
      await expirerAbonnement(p.ownerId);
      expect((await api().get(BASE).set(p.h)).status).toBe(200);
      expect((await api().get(`${BASE}/${id}/fichier`).set(p.h)).status).toBe(200);
      expect((await televerser(p, { entity_type: 'building', entity_id: building.id, category: 'autre' })).status).toBe(402);
      expect((await api().patch(`${BASE}/${id}`).set(p.h).send({ visible_to_tenant: false })).status).toBe(402);
      expect((await api().delete(`${BASE}/${id}`).set(p.h)).status).toBe(402);
    });
  });
});
