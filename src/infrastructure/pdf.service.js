'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

/**
 * Génération de PDF (quittances § 13, bail § 53, état des lieux § 52, reçu de
 * caution § 55) avec pdfkit — pur JavaScript, sans navigateur embarqué
 * (Widjila : pdfkit ; Sign utilisait Chromium, bien plus lourd en production).
 *
 * Toutes les chaînes insérées viennent de la base : pdfkit les écrit comme du
 * texte, aucune interprétation (pas d'injection possible dans le document).
 */

// Charte Kërimmo (mêmes teintes que l'application mobile).
const COULEURS = {
  texte: '#1f2937', gris: '#64748b', trait: '#e2e8f0', accent: '#0e56b0', marine: '#0b2a5b', vert: '#2e9e1f', fond: '#f3f7fc',
};

const HAUT_ENTETE = 100;
const CHEMIN_LOGO = path.join(__dirname, '../assets/logo_kerimmo.png');
// Lu une fois ; sans le fichier, l'en-tête s'affiche simplement sans logo.
const LOGO = fs.existsSync(CHEMIN_LOGO) ? fs.readFileSync(CHEMIN_LOGO) : null;

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
      info: { Title: meta.titre || 'Document', Author: meta.auteur || (process.env.APP_NAME || 'Kërimmo'), Producer: 'pdfkit' },
      bufferPages: true,
    });
    const morceaux = [];
    doc.on('data', (m) => morceaux.push(m));
    doc.on('end', () => resolve(Buffer.concat(morceaux)));
    doc.on('error', reject);

    Promise.resolve()
      .then(() => dessiner(doc, aides(doc)))
      .then(() => {
        piedsDePage(doc, meta.titre);
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
  const gauche = () => doc.page.margins.left;
  const bas = () => doc.page.height - doc.page.margins.bottom;
  /** Saut de page si moins de `hauteur` reste disponible. */
  const place = (hauteur) => {
    if (doc.y + hauteur > bas()) doc.addPage();
  };
  return {
    /**
     * En-tête de document sur fond blanc : logo, titre et référence, trait vert.
     * @param {string} texte
     * @param {string} [detail] référence, version… sous le titre
     */
    titre(texte, detail) {
      const droite = doc.page.width - doc.page.margins.right;
      let debut = gauche();
      if (LOGO) {
        doc.image(LOGO, gauche(), 28, { fit: [116, 60], align: 'left', valign: 'center' });
        debut = gauche() + 130;
      }
      const largeurTitre = droite - debut;
      doc.font('Helvetica-Bold').fontSize(17);
      const hauteurTitre = doc.heightOfString(texte, { width: largeurTitre });
      doc.font('Helvetica').fontSize(8.5);
      const hauteurDetail = detail ? doc.heightOfString(detail, { width: largeurTitre }) + 4 : 0;
      const y = Math.max(20, (HAUT_ENTETE + 16 - hauteurTitre - hauteurDetail) / 2);
      doc.font('Helvetica-Bold').fontSize(17).fillColor(COULEURS.marine).text(texte, debut, y, { width: largeurTitre, align: 'right' });
      if (detail) {
        doc.font('Helvetica').fontSize(8.5).fillColor(COULEURS.gris).text(detail, debut, y + hauteurTitre + 4, { width: largeurTitre, align: 'right' });
      }
      doc.moveTo(gauche(), HAUT_ENTETE).lineTo(droite, HAUT_ENTETE).lineWidth(1.5).strokeColor(COULEURS.vert).stroke().lineWidth(1);
      doc.x = gauche();
      doc.y = HAUT_ENTETE + 14;
      doc.fillColor(COULEURS.texte).font('Helvetica').fontSize(10);
    },
    /**
     * Titre de section, jamais seul en bas de page.
     * @param {string} texte
     * @param {number} [reserve] hauteur à garder avec le titre (tableau court à ne pas couper)
     */
    sousTitre(texte, reserve = 70) {
      doc.moveDown(0.8);
      place(Math.min(reserve, bas() - doc.page.margins.top));
      doc.x = gauche();
      doc.fillColor(COULEURS.marine).fontSize(11.5).font('Helvetica-Bold').text(texte);
      doc.x = gauche();
      doc.moveDown(0.5);
      doc.fillColor(COULEURS.texte).font('Helvetica').fontSize(10);
    },
    /** Lignes « Libellé    valeur », séparées par un filet. */
    champs(paires) {
      const lignes = paires.filter(([, v]) => v !== undefined && v !== null && v !== '');
      const colonne = Math.min(150, largeur() * 0.34);
      const valeurX = gauche() + colonne;
      const largeurValeur = largeur() - colonne;
      lignes.forEach(([libelle, valeur]) => {
        doc.font('Helvetica-Bold').fontSize(9.5);
        const h = Math.max(
          doc.heightOfString(String(valeur), { width: largeurValeur }),
          doc.font('Helvetica').heightOfString(String(libelle), { width: colonne - 20 })
        );
        place(h + 10);
        const y = doc.y;
        doc.moveTo(gauche(), y + h + 10).lineTo(gauche() + largeur(), y + h + 10).strokeColor(COULEURS.trait).stroke();
        doc.font('Helvetica').fontSize(9.5).fillColor(COULEURS.gris).text(String(libelle), gauche(), y + 5, { width: colonne - 20 });
        doc.font('Helvetica-Bold').fillColor(COULEURS.texte).text(String(valeur), valeurX, y + 5, { width: largeurValeur });
        doc.x = gauche();
        doc.y = y + h + 10;
      });
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(10).fillColor(COULEURS.texte);
    },
    paragraphe(texte, options = {}) {
      doc.x = gauche();
      doc.font('Helvetica').fontSize(options.taille || 10).fillColor(options.couleur || COULEURS.texte)
        .text(String(texte || ''), { align: options.align || 'justify', lineGap: 2 });
      doc.moveDown(0.4);
    },
    note(texte) {
      doc.x = gauche();
      doc.font('Helvetica').fontSize(8).fillColor(COULEURS.gris).text(texte, { align: 'left' });
      doc.fillColor(COULEURS.texte).fontSize(10);
    },
    /** Tableau sobre : en-tête répété à chaque page, lignes séparées par un filet. */
    tableau(entetes, lignes, largeursRelatives) {
      const total = largeur();
      const somme = largeursRelatives.reduce((a, b) => a + b, 0);
      const colonnes = largeursRelatives.map((l) => (l / somme) * total);
      const RETRAIT = 7;
      const hauteurDe = (cellules, gras) => {
        doc.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
        return Math.max(...cellules.map((c, i) => doc.heightOfString(String(c ?? ''), { width: colonnes[i] - RETRAIT * 2 }))) + 12;
      };
      const ecrire = (cellules, { gras = false, couleur = COULEURS.texte, trait = COULEURS.trait } = {}) => {
        const hauteur = hauteurDe(cellules, gras);
        const y = doc.y;
        let x = gauche();
        cellules.forEach((c, i) => {
          doc.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(couleur)
            .text(String(c ?? ''), x + RETRAIT, y + 6, { width: colonnes[i] - RETRAIT * 2 });
          x += colonnes[i];
        });
        doc.moveTo(gauche(), y + hauteur).lineTo(gauche() + total, y + hauteur).strokeColor(trait).stroke();
        doc.x = gauche();
        doc.y = y + hauteur;
      };
      const enTete = () => ecrire(entetes, { gras: true, couleur: COULEURS.marine, trait: COULEURS.marine });
      // L'en-tête reste avec au moins sa première ligne.
      place(hauteurDe(entetes, true) + (lignes.length ? hauteurDe(lignes[0], false) : 0));
      enTete();
      lignes.forEach((l) => {
        const hauteur = hauteurDe(l, false);
        if (doc.y + hauteur > bas()) {
          doc.addPage();
          enTete();
        }
        ecrire(l);
      });
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(10).fillColor(COULEURS.texte);
    },
    largeur,
  };
}

function piedsDePage(doc, titre) {
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    const bas = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const gauche = doc.page.margins.left;
    const largeur = doc.page.width - gauche - doc.page.margins.right;
    const y = doc.page.height - 42;
    doc.moveTo(gauche, y).lineTo(gauche + largeur, y).strokeColor(COULEURS.trait).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(COULEURS.gris);
    doc.text(['Kërimmo', titre].filter(Boolean).join(' · '), gauche, y + 8, { width: largeur - 70, lineBreak: false });
    doc.text(`Page ${i + 1} / ${pages.count}`, gauche, y + 8, { width: largeur, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bas;
  }
}

module.exports = { generer, COULEURS };
