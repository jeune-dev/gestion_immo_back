'use strict';

const sharp = require('sharp');
const {
  api, nouveauProprietaire, superAdmin, bailActif, activerLocataire, fermer, sequelize,
} = require('../../../setup/helpers.js');
const storage = require('../../../../infrastructure/storage.service.js');

/**
 * Documents : téléversement manuel (§ 7, § 9, § 10), flux sécurisé et
 * miniature (§ 37), partage avec le locataire (§ 27 « document disponible »),
 * contrôle d'accès horizontal (§ 32, § 43), suppression protégée (§ 42).
 */

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const BASE = '/api/v1/documents';

function televerser(proprio, champs, contenu = PDF, nom = 'piece.pdf') {
  const req = api().post(BASE).set(proprio.h);
  for (const [cle, valeur] of Object.entries(champs)) req.field(cle, String(valeur));
  return req.attach('fichier', contenu, nom);
}

/** Corps binaire d'une réponse supertest (flux de fichier). */
const binaire = (req) => req.buffer(true).parse((res, cb) => {
  const morceaux = [];
  res.on('data', (m) => morceaux.push(m));
  res.on('end', () => cb(null, Buffer.concat(morceaux)));
});

describe('Documents', () => {
  let A; let B; let bailA; let locA; let png;

  beforeAll(async () => {
    png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).png().toBuffer();
    A = await nouveauProprietaire();
    B = await nouveauProprietaire();
    bailA = await bailActif(A);
    locA = await activerLocataire(A, bailA.tenant);
  });

  afterAll(fermer);

  test('pièce d\'identité du locataire : téléversement, liste, flux (octets et en-têtes)', async () => {
    const res = await televerser(A, { entity_type: 'tenant', entity_id: bailA.tenant.id, category: 'piece_identite' }, PDF, 'CNI "Ndiaye".pdf');
    expect(res.status).toBe(201);
    const doc = res.body.data.document;
    expect(doc).toMatchObject({ category: 'piece_identite', mime_type: 'application/pdf', visible_to_tenant: false, has_thumbnail: false });
    expect(doc).not.toHaveProperty('storage_key');

    const liste = await api().get(`${BASE}?entity_type=tenant&entity_id=${bailA.tenant.id}`).set(A.h);
    expect(liste.status).toBe(200);
    expect(liste.body.data.items.map((d) => d.id)).toContain(doc.id);

    const flux = await binaire(api().get(`${BASE}/${doc.id}/fichier`).set(A.h));
    expect(flux.status).toBe(200);
    expect(Buffer.compare(flux.body, PDF)).toBe(0);
    expect(flux.headers['content-type']).toBe('application/pdf');
    expect(flux.headers['content-length']).toBe(String(PDF.length));
    expect(flux.headers['cache-control']).toBe('private, no-store');
    expect(flux.headers['x-content-type-options']).toBe('nosniff');
    const disposition = flux.headers['content-disposition'];
    expect(disposition).toMatch(/^inline; filename="CNI Ndiaye\.pdf"; filename\*=UTF-8''CNI%20Ndiaye\.pdf$/);

    const lien = await api().get(`${BASE}/${doc.id}/lien`).set(A.h);
    expect(lien.status).toBe(200);
    expect(lien.body.data).toEqual({ url: `/api/v1/documents/${doc.id}/fichier`, expires_in: null });
  });

  test('photo d\'immeuble : miniature WebP servie à la demande (§ 37)', async () => {
    const res = await televerser(A, { entity_type: 'building', entity_id: bailA.building.id, category: 'photo', captured_at: '2026-09-20T10:00:00Z' }, png, 'facade (1).png');
    expect(res.status).toBe(201);
    expect(res.body.data.document.has_thumbnail).toBe(true);
    expect(res.body.data.document.captured_at).toBe('2026-09-20T10:00:00.000Z');
    const miniature = await binaire(api().get(`${BASE}/${res.body.data.document.id}/fichier?taille=miniature`).set(A.h));
    expect(miniature.status).toBe(200);
    expect(miniature.headers['content-type']).toBe('image/webp');
    expect(miniature.body.toString('ascii', 8, 12)).toBe('WEBP');
    expect(miniature.headers['content-disposition']).toContain("filename*=UTF-8''miniature-facade%20%281%29.webp");
  });

  test('autre propriétaire → 403 (lecture, liste, téléversement, modification, suppression)', async () => {
    const res = await televerser(A, { entity_type: 'lease', entity_id: bailA.lease.id, category: 'autre' });
    const id = res.body.data.document.id;
    expect((await api().get(`${BASE}/${id}/fichier`).set(B.h)).status).toBe(403);
    expect((await api().get(`${BASE}/${id}/lien`).set(B.h)).status).toBe(403);
    expect((await api().get(`${BASE}?entity_type=lease&entity_id=${bailA.lease.id}`).set(B.h)).status).toBe(403);
    expect((await televerser(B, { entity_type: 'building', entity_id: bailA.building.id, category: 'photo' }, png, 'x.png')).status).toBe(403);
    expect((await api().patch(`${BASE}/${id}`).set(B.h).send({ visible_to_tenant: true })).status).toBe(403);
    expect((await api().delete(`${BASE}/${id}`).set(B.h)).status).toBe(403);
    // Sa propre liste ne contient rien de A.
    const listeB = await api().get(BASE).set(B.h);
    expect(listeB.body.data.items.map((d) => d.id)).not.toContain(id);
  });

  test('locataire : document non partagé → 403 ; partagé → lisible, et notifié', async () => {
    const res = await televerser(A, { entity_type: 'lease', entity_id: bailA.lease.id, category: 'contrat' }, PDF, 'bail-signe.pdf');
    const id = res.body.data.document.id;
    expect((await api().get(`${BASE}/${id}/fichier`).set(locA.h)).status).toBe(403);
    expect((await api().get(BASE).set(locA.h)).body.data.items.map((d) => d.id)).not.toContain(id);

    const partage = await api().patch(`${BASE}/${id}`).set(A.h).send({ visible_to_tenant: true });
    expect(partage.status).toBe(200);
    expect(partage.body.data.document.visible_to_tenant).toBe(true);
    const [[{ n }]] = await sequelize.query(
      "SELECT count(*)::int AS n FROM notifications WHERE user_id = :u AND type = 'document_disponible' AND data->>'document_id' = :id",
      { replacements: { u: locA.user.id, id } }
    );
    expect(n).toBe(1);

    const flux = await binaire(api().get(`${BASE}/${id}/fichier`).set(locA.h));
    expect(flux.status).toBe(200);
    expect(Buffer.compare(flux.body, PDF)).toBe(0);
    const liste = await api().get(`${BASE}?entity_type=lease&entity_id=${bailA.lease.id}`).set(locA.h);
    expect(liste.body.data.items.map((d) => d.id)).toEqual([id]);

    // Le locataire ne téléverse, ne modifie ni ne supprime rien ici.
    expect((await api().patch(`${BASE}/${id}`).set(locA.h).send({ visible_to_tenant: false })).status).toBe(403);
    expect((await api().delete(`${BASE}/${id}`).set(locA.h)).status).toBe(403);

    // Téléversement directement partagé : notifié aussi.
    const direct = await televerser(A, { entity_type: 'tenant', entity_id: bailA.tenant.id, category: 'justificatif', visible_to_tenant: 'true' });
    expect(direct.status).toBe(201);
    expect((await api().get(`${BASE}/${direct.body.data.document.id}/fichier`).set(locA.h)).status).toBe(200);
  });

  test('suppression : photo manuelle supprimée (logiquement) ; contrat protégé → 409', async () => {
    const photo = await televerser(A, { entity_type: 'apartment', entity_id: bailA.apartment.id, category: 'photo' }, png, 'salon.png');
    const id = photo.body.data.document.id;
    const suppression = await api().delete(`${BASE}/${id}`).set(A.h);
    expect(suppression.status).toBe(200);
    expect((await api().get(`${BASE}/${id}/fichier`).set(A.h)).status).toBe(404);
    const [[ligne]] = await sequelize.query('SELECT deleted_at FROM documents WHERE id = :id', { replacements: { id } });
    expect(ligne.deleted_at).not.toBeNull();
    const [[audit]] = await sequelize.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'document.suppression' AND entity_id = :id", { replacements: { id } });
    expect(audit.n).toBe(1);

    const contrat = await televerser(A, { entity_type: 'lease', entity_id: bailA.lease.id, category: 'contrat' });
    const refus = await api().delete(`${BASE}/${contrat.body.data.document.id}`).set(A.h);
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('DOCUMENT_PROTEGE');
  });

  test('validation, absence, objet manquant, super admin', async () => {
    expect((await televerser(A, { entity_type: 'work_order', entity_id: bailA.building.id, category: 'photo' }, png, 'x.png')).status).toBe(422);
    expect((await televerser(A, { entity_type: 'building', entity_id: bailA.building.id, category: 'quittance' })).status).toBe(422);
    // Un document d'immeuble ne concerne aucun locataire : il ne peut pas être partagé.
    expect((await televerser(A, { entity_type: 'building', entity_id: bailA.building.id, category: 'autre', visible_to_tenant: 'true' })).status).toBe(422);
    expect((await api().post(BASE).set(A.h).field('entity_type', 'building').field('entity_id', bailA.building.id).field('category', 'photo')).status).toBe(400);
    expect((await api().get(`${BASE}?entity_type=building`).set(A.h)).status).toBe(422);

    const inconnu = '6f1c1d52-8d4b-4c8e-9a51-2f3c2b0d9e11';
    expect((await api().get(`${BASE}/${inconnu}/fichier`).set(A.h)).status).toBe(404);
    expect((await televerser(A, { entity_type: 'building', entity_id: inconnu, category: 'photo' }, png, 'x.png')).status).toBe(404);

    const res = await televerser(A, { entity_type: 'building', entity_id: bailA.building.id, category: 'autre' });
    const id = res.body.data.document.id;
    const [[{ storage_key: cle }]] = await sequelize.query('SELECT storage_key FROM documents WHERE id = :id', { replacements: { id } });
    await storage.supprimer(cle);
    const manquant = await api().get(`${BASE}/${id}/fichier`).set(A.h);
    expect(manquant.status).toBe(404);
    expect(manquant.body.error.code).toBe('FICHIER_INTROUVABLE');

    const admin = await superAdmin();
    expect((await api().get(`${BASE}/${id}/fichier`).set(admin.h)).status).toBe(403);
  });
});
