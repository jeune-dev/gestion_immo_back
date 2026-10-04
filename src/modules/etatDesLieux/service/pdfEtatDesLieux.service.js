'use strict';

const sharp = require('sharp');
const pdf = require('../../../infrastructure/pdf.service.js');
const storage = require('../../../infrastructure/storage.service.js');
const {
  TYPE_ETAT_DES_LIEUX, STATUT_ETAT_DES_LIEUX, ELEMENT_ETAT_DES_LIEUX, ETAT_ELEMENT, TYPE_APPARTEMENT,
} = require('../../../config/enums.js');
const logger = require('../../../utils/logger.js');

/**
 * Export PDF d'un état des lieux avec photos (§ 52.3 étape 4 : « une fois
 * accepté, l'état des lieux est verrouillé, archivé et exporté en PDF avec
 * photos »).
 *
 * - Les photos sont intégrées en MINIATURE (WebP 480 px produite au
 *   téléversement, § 37) : un état des lieux de 60 photos reste un PDF léger.
 *   pdfkit ne lit que JPEG et PNG : la miniature est convertie en JPEG en
 *   mémoire. Une photo illisible (objet absent du stockage) est signalée dans
 *   le document, jamais passée sous silence, et ne bloque pas l'export.
 * - Un brouillon porte le filigrane « BROUILLON » : il ne peut pas être
 *   confondu avec la version présentée au locataire.
 */

const FUSEAU = process.env.APP_TIMEZONE || 'Africa/Dakar';
const COTE_PHOTO = 120;
const ECART_PHOTO = 8;
// Lectures parallèles bornées : un gros état des lieux ne sature ni le stockage ni la mémoire.
const LECTURES_SIMULTANEES = 6;

const FILIGRANES = Object.freeze({ brouillon: 'BROUILLON', remplace: 'VERSION REMPLACÉE' });

const formatHeure = new Intl.DateTimeFormat('fr-FR', { timeZone: FUSEAU, dateStyle: 'long', timeStyle: 'short' });

function dateHeure(valeur) {
  if (!valeur) return null;
  const d = valeur instanceof Date ? valeur : new Date(valeur);
  return Number.isNaN(d.getTime()) ? null : formatHeure.format(d);
}

/** Miniature (ou original) d'une photo, convertie en JPEG pour pdfkit ; null si illisible. */
async function imagePourPdf(document) {
  try {
    const brut = await storage.lire(document.thumbnail_key || document.storage_key);
    if (!brut) return null;
    return await sharp(brut).resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
  } catch (err) {
    logger.warn('[etat_des_lieux] Photo illisible pour le PDF', { document_id: document.id, error: err.message });
    return null;
  }
}

/** Charge toutes les images (par lots bornés) : Map document_id → Buffer|null. */
async function chargerImages(rooms) {
  const documents = [];
  for (const room of rooms) for (const item of room.items) for (const p of item.photos) if (p.document) documents.push(p.document);
  const images = new Map();
  for (let i = 0; i < documents.length; i += LECTURES_SIMULTANEES) {
    const lot = documents.slice(i, i + LECTURES_SIMULTANEES);
    const contenus = await Promise.all(lot.map(imagePourPdf));
    lot.forEach((d, j) => images.set(d.id, contenus[j]));
  }
  return images;
}

function libelleElement(item) {
  const base = ELEMENT_ETAT_DES_LIEUX[item.element] || item.element;
  return item.label ? `${base} — ${item.label}` : base;
}

function dessinerPhotos(doc, a, item, images) {
  const photos = item.photos.filter((p) => p.document);
  if (!photos.length) return;
  a.note(`Photos — ${libelleElement(item)}`);
  const gauche = doc.page.margins.left;
  const parLigne = Math.max(1, Math.floor((a.largeur() + ECART_PHOTO) / (COTE_PHOTO + ECART_PHOTO)));
  let y = doc.y + 4;
  photos.forEach((p, i) => {
    const colonne = i % parLigne;
    if (colonne === 0 && i > 0) y += COTE_PHOTO + 22;
    if (y + COTE_PHOTO + 20 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    const x = gauche + colonne * (COTE_PHOTO + ECART_PHOTO);
    const image = images.get(p.document.id);
    if (image) {
      doc.image(image, x, y, { fit: [COTE_PHOTO, COTE_PHOTO], align: 'center', valign: 'center' });
    } else {
      doc.rect(x, y, COTE_PHOTO, COTE_PHOTO).strokeColor(pdf.COULEURS.trait).stroke();
      doc.fontSize(8).fillColor(pdf.COULEURS.gris).text('Photo indisponible', x + 4, y + COTE_PHOTO / 2 - 4, { width: COTE_PHOTO - 8, align: 'center' });
    }
    // § 52.4 — les deux horodatages : prise de vue (mobile) et réception (serveur).
    const legende = [p.captured_at ? `Prise : ${dateHeure(p.captured_at)}` : null, `Reçue : ${dateHeure(p.created_at)}`].filter(Boolean).join('\n');
    doc.fontSize(6).fillColor(pdf.COULEURS.gris).text(legende, x, y + COTE_PHOTO + 2, { width: COTE_PHOTO, align: 'left' });
  });
  doc.x = gauche;
  doc.y = y + COTE_PHOTO + 24;
  doc.fillColor(pdf.COULEURS.texte).fontSize(10);
}

function filigrane(doc, texte) {
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(pages.start + i);
    const { width: l, height: h } = doc.page;
    const bas = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.save();
    doc.rotate(-45, { origin: [l / 2, h / 2] });
    doc.fontSize(72).font('Helvetica-Bold').fillColor('#9ca3af').fillOpacity(0.25)
      .text(texte, 0, h / 2 - 36, { width: l, align: 'center', lineBreak: false });
    doc.restore();
    doc.fillOpacity(1);
    doc.page.margins.bottom = bas;
  }
}

/**
 * @param {object} edl   état des lieux (JSON) avec lease, apartment (+ building), tenant
 * @param {Array} rooms  arbre pièces → éléments → photos (photos[].document = ligne documents)
 * @param {object} owner propriétaire (display_name, company_name, phone)
 * @returns {Promise<Buffer>}
 */
async function genererPdf(edl, rooms, owner) {
  const images = await chargerImages(rooms);
  const titre = `État des lieux ${edl.type === 'entree' ? "d'entrée" : 'de sortie'}`;
  const apt = edl.apartment || {};
  const immeuble = apt.building || {};
  const locataire = edl.tenant ? `${edl.tenant.first_name} ${edl.tenant.last_name}` : null;

  return pdf.generer((doc, a) => {
    a.titre(titre);
    a.note(`Version ${edl.version} — statut : ${STATUT_ETAT_DES_LIEUX[edl.status] || edl.status} — document généré le ${dateHeure(new Date())}`);
    doc.moveDown(0.5);

    a.sousTitre('Logement et parties');
    a.champs([
      ['Type', TYPE_ETAT_DES_LIEUX[edl.type]],
      ['Bail', edl.lease?.reference],
      ['Immeuble', [immeuble.name, immeuble.address, immeuble.city].filter(Boolean).join(', ')],
      ['Logement', [apt.number, TYPE_APPARTEMENT[apt.type]].filter(Boolean).join(' — ')],
      ['Bailleur', owner ? (owner.company_name ? `${owner.company_name} (${owner.display_name})` : owner.display_name) : null],
      ['Locataire', locataire],
      ['Date et heure', dateHeure(edl.performed_at)],
    ]);
    if (edl.parties_present?.length) {
      a.paragraphe(`Parties présentes : ${edl.parties_present.map((p) => `${p.name} (${p.role})`).join(' ; ')}`, { align: 'left' });
    }

    a.sousTitre('Compteurs et clés');
    a.champs([
      ['Compteur d’eau', edl.water_meter ?? 'non relevé'],
      ['Compteur d’électricité', edl.electricity_meter ?? 'non relevé'],
      ['Clés remises', edl.keys_count ?? 'non précisé'],
      ['Détail des clés', edl.keys_details],
    ]);

    for (const room of rooms) {
      a.sousTitre(room.name);
      if (room.notes) a.paragraphe(room.notes, { align: 'left' });
      if (!room.items.length) {
        a.note('Aucun élément relevé dans cette pièce.');
        continue;
      }
      a.tableau(
        ['Élément', 'État', 'Commentaire', 'Photos'],
        room.items.map((it) => [libelleElement(it), ETAT_ELEMENT[it.condition] || it.condition, it.comment || '', String(it.photos.filter((p) => p.document).length)]),
        [3, 1.5, 5, 1]
      );
      for (const item of room.items) dessinerPhotos(doc, a, item, images);
    }

    if (edl.general_observations) {
      a.sousTitre('Observations générales');
      a.paragraphe(edl.general_observations, { align: 'left' });
    }

    a.sousTitre('Présentation au locataire et validation');
    a.champs([
      ['Soumis au locataire le', dateHeure(edl.submitted_at)],
      ['Délai de réponse', dateHeure(edl.response_deadline)],
      ['Accepté le', edl.accepted_at ? `${dateHeure(edl.accepted_at)}${edl.accepted_tacitly ? ' (acceptation tacite à l’expiration du délai)' : ' (acceptation dans l’application)'}` : null],
      ['Contesté le', dateHeure(edl.contested_at)],
      ['Motif de la contestation', edl.contest_comment],
    ]);
    // § 52.4 — en V1, l'acceptation dans l'application fait office de validation.
    a.note("L'acceptation par le locataire dans l'application fait office de validation (signature électronique prévue en V2).");

    if (FILIGRANES[edl.status]) filigrane(doc, FILIGRANES[edl.status]);
  }, { titre });
}

module.exports = { genererPdf, dateHeure };
