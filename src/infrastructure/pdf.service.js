'use strict';

const PDFDocument = require('pdfkit');

/**
 * Génération de PDF (quittances § 13, bail § 53, état des lieux § 52, reçu de
 * caution § 55) avec pdfkit — pur JavaScript, sans navigateur embarqué
 * (Widjila : pdfkit ; Sign utilisait Chromium, bien plus lourd en production).
 *
 * Toutes les chaînes insérées viennent de la base : pdfkit les écrit comme du
 * texte, aucune interprétation (pas d'injection possible dans le document).
 */

const COULEURS = { texte: '#1f2937', gris: '#6b7280', trait: '#d1d5db', accent: '#0f766e' };

/**
 * Construit un PDF en mémoire.
 * @param {(doc: PDFKit.PDFDocument, aides: object) => (void|Promise<void>)} dessiner
 * @param {{ titre?: string, auteur?: string }} [meta]
 * @returns {Promise<Buffer>}
 */
function generer(dessiner, meta = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 60, left: 50, right: 50 },
      info: { Title: meta.titre || 'Document', Author: meta.auteur || (process.env.APP_NAME || 'Gestion Immo'), Producer: 'pdfkit' },
      bufferPages: true,
    });
    const morceaux = [];
    doc.on('data', (m) => morceaux.push(m));
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);

    Promise.resolve()
      .then(() => dessiner(doc, aides(doc)))
      .then(() => {
        piedsDePage(doc);
        doc.end();
      })
      .catch((err) => {
        doc.end();
        reject(err);
      });
  });
}

function aides(doc) {
  const largeur = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
  return {
    titre(texte) {
      doc.fillColor(COULEURS.accent).fontSize(20).font('Helvetica-Bold').text(texte, { align: 'center' });
      doc.moveDown(0.3);
      doc.fillColor(COULEURS.texte).font('Helvetica').fontSize(10);
    },
    sousTitre(texte) {
      doc.moveDown(0.6);
      doc.fillColor(COULEURS.accent).fontSize(12).font('Helvetica-Bold').text(texte);
      const y = doc.y + 2;
      doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + largeur(), y).strokeColor(COULEURS.trait).stroke();
      doc.moveDown(0.4);
      doc.fillColor(COULEURS.texte).font('Helvetica').fontSize(10);
    },
    /** Lignes « Libellé : valeur ». */
    champs(paires) {
      for (const [libelle, valeur] of paires) {
        if (valeur === undefined || valeur === null || valeur === '') continue;
        doc.font('Helvetica-Bold').text(`${libelle} : `, { continued: true }).font('Helvetica').text(String(valeur));
      }
    },
    paragraphe(texte, options = {}) {
      doc.font('Helvetica').fontSize(options.taille || 10).fillColor(options.couleur || COULEURS.texte)
        .text(String(texte || ''), { align: options.align || 'justify' });
      doc.moveDown(0.4);
    },
    note(texte) {
      doc.fontSize(8).fillColor(COULEURS.gris).text(texte, { align: 'left' });
      doc.fillColor(COULEURS.texte).fontSize(10);
    },
    /** Tableau simple : entêtes + lignes (texte). */
    tableau(entetes, lignes, largeursRelatives) {
      const total = largeur();
      const somme = largeursRelatives.reduce((a, b) => a + b, 0);
      const colonnes = largeursRelatives.map((l) => (l / somme) * total);
      const ecrireLigne = (cellules, gras) => {
        const y = doc.y;
        let x = doc.page.margins.left;
        let hauteur = 0;
        cellules.forEach((c, i) => {
          doc.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
          const h = doc.heightOfString(String(c ?? ''), { width: colonnes[i] - 6 });
          hauteur = Math.max(hauteur, h);
        });
        if (y + hauteur + 8 > doc.page.height - doc.page.margins.bottom) doc.addPage();
        const yl = doc.y;
        cellules.forEach((c, i) => {
          doc.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(COULEURS.texte)
            .text(String(c ?? ''), x + 3, yl + 3, { width: colonnes[i] - 6 });
          x += colonnes[i];
        });
        doc.y = yl + hauteur + 6;
        doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + total, doc.y).strokeColor(COULEURS.trait).stroke();
        doc.x = doc.page.margins.left;
      };
      ecrireLigne(entetes, true);
      lignes.forEach((l) => ecrireLigne(l, false));
      doc.moveDown(0.5);
      doc.fontSize(10);
    },
    largeur,
  };
}

function piedsDePage(doc) {
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    const bas = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fontSize(8).fillColor(COULEURS.gris).text(
      `Page ${i + 1} / ${pages.count}`,
      doc.page.margins.left,
      doc.page.height - 40,
      { align: 'center', width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
    doc.page.margins.bottom = bas;
  }
}

module.exports = { generer, COULEURS };
