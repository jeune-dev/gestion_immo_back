'use strict';

const pdf = require('../../../infrastructure/pdf.service.js');
const { versApi } = require('../../../modules/document/service/document.service.js');

afterAll(() => require('../../../config/db.js').close());

/**
 * pdf.service.generer (quittances, contrats, états des lieux, reçus de
 * caution) et document.service.versApi (représentation d'API d'un document).
 */

/** Nombre de pages d'un PDF : objets `/Type /Page` (hors `/Type /Pages`). */
const pages = (buffer) => (buffer.toString('latin1').match(/\/Type \/Page(?!s)/g) || []).length;

describe('pdf.generer', () => {
  test('produit un PDF valide d’une page : en-tête %PDF-, fin %%EOF, métadonnées', async () => {
    const buffer = await pdf.generer((doc, a) => {
      a.titre('REÇU DE CAUTION');
      a.champs([['Bail', 'BAIL-2026-0001'], ['Montant', '700 000 FCFA'], ['Vide', ''], ['Nul', null]]);
      a.note('Note de bas de page');
    }, { titre: 'Reçu' });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pages(buffer)).toBe(1);
    expect(buffer.toString('latin1')).toContain('/Producer');
  });

  test('document long : plusieurs pages (tableau paginé, paragraphes), pied de page sur chacune', async () => {
    const lignes = Array.from({ length: 120 }, (_, i) => [`Pièce ${i}`, 'Murs', 'Bon état général, rien à signaler', '—']);
    const buffer = await pdf.generer((doc, a) => {
      a.titre('ÉTAT DES LIEUX');
      a.sousTitre('Pièces');
      a.tableau(['Pièce', 'Élément', 'État', 'Photo'], lignes, [2, 2, 4, 1]);
      a.paragraphe('Observations '.repeat(400));
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(buffer)).toBeGreaterThanOrEqual(3);
  });

  test('pages ajoutées explicitement : compte exact', async () => {
    const buffer = await pdf.generer((doc) => {
      doc.text('Un');
      doc.addPage();
      doc.text('Deux');
      doc.addPage();
      doc.text('Trois');
    });
    expect(pages(buffer)).toBe(3);
  });

  test('dessin asynchrone pris en charge ; une erreur de dessin rejette la promesse', async () => {
    const buffer = await pdf.generer(async (doc, a) => {
      await new Promise((r) => { setTimeout(r, 5); });
      a.paragraphe('Asynchrone');
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    await expect(pdf.generer(() => { throw new Error('dessin impossible'); })).rejects.toThrow('dessin impossible');
    await expect(pdf.generer(async () => { throw new Error('async impossible'); })).rejects.toThrow('async impossible');
  });

  test('chaînes hostiles écrites comme du texte (aucune interprétation)', async () => {
    const buffer = await pdf.generer((doc, a) => {
      a.paragraphe(') /JavaScript (app.alert(1)) << /S /JavaScript >>');
      a.champs([['Nom', '\u0000\u001f<script>'], ['Nombre', 0]]);
      a.paragraphe(undefined);
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.toString('latin1')).not.toMatch(/\/S \/JavaScript/);
  });
});

describe('document.versApi', () => {
  const ligne = {
    id: 'd1', owner_id: 'o1', tenant_id: 't1', entity_type: 'lease', entity_id: 'l1', category: 'contrat',
    storage_key: 'owners/o1/lease/secret.pdf', thumbnail_key: 'owners/o1/lease/miniatures/secret.webp',
    mime_type: 'application/pdf', size_bytes: 1234, original_name: 'bail.pdf', checksum: 'abc',
    visible_to_tenant: true, captured_at: null, created_at: '2026-09-28T10:00:00.000Z', uploaded_by: 'u1', deleted_at: null,
  };

  test('n’expose jamais la clé de stockage, la miniature, l’empreinte, ni les identifiants internes', () => {
    const api = versApi(ligne);
    expect(Object.keys(api).sort()).toEqual(['captured_at', 'category', 'created_at', 'has_thumbnail', 'id', 'mime_type', 'original_name', 'size_bytes', 'url', 'visible_to_tenant']);
    const texte = JSON.stringify(api);
    for (const secret of ['secret.pdf', 'secret.webp', 'owners/', 'abc', 'o1', 'u1']) expect(texte).not.toContain(secret);
  });

  test('miniature signalée par un booléen ; URL de flux authentifiée', () => {
    expect(versApi(ligne)).toMatchObject({ has_thumbnail: true, url: '/api/v1/documents/d1/fichier' });
    expect(versApi({ ...ligne, thumbnail_key: null }).has_thumbnail).toBe(false);
  });
});
