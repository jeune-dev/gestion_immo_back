'use strict';

const sharp = require('sharp');

/**
 * Traitement des images (§ 37 « compression des images, génération de
 * miniature, chargement basse résolution puis haute résolution »).
 *
 * - Original : orientation EXIF appliquée puis métadonnées SUPPRIMÉES — une
 *   photo de smartphone embarque souvent les coordonnées GPS du domicile du
 *   locataire (minimisation des données, recommandations CNIL citées § 1).
 *   Les très grandes images sont ramenées à 2560 px de côté.
 * - Miniature : WebP 480 px, chargée en premier par le mobile.
 *
 * `sharp.concurrency` et le cache libvips restent à leurs valeurs par défaut :
 * le traitement se fait dans le pool de threads libuv, hors boucle d'événements.
 */

const COTE_MAX = parseInt(process.env.IMAGE_COTE_MAX || '2560', 10);
const COTE_MINIATURE = parseInt(process.env.IMAGE_COTE_MINIATURE || '480', 10);

// Garde anti « bombe de décompression » : 50 mégapixels maximum.
// 24 Mpx : largement au-dessus d'une photo de téléphone (12–20 Mpx), et un
// décodage borné à ~100 Mo au lieu de ~200 Mo (constat F3 de l'audit).
const OPTIONS_ENTREE = { limitInputPixels: 24_000_000, failOn: 'error' };

/**
 * @param {Buffer} buffer
 * @param {'jpg'|'png'|'webp'} type
 * @returns {Promise<{ original: Buffer, miniature: Buffer }>}
 */
async function preparerImage(buffer, type) {
  const base = sharp(buffer, OPTIONS_ENTREE).rotate().resize({
    width: COTE_MAX, height: COTE_MAX, fit: 'inside', withoutEnlargement: true,
  });

  let original;
  if (type === 'png') original = await base.clone().png({ compressionLevel: 6 }).toBuffer();
  else if (type === 'webp') original = await base.clone().webp({ quality: 85 }).toBuffer();
  else original = await base.clone().jpeg({ quality: 85, mozjpeg: true }).toBuffer();

  const miniature = await sharp(buffer, OPTIONS_ENTREE)
    .rotate()
    .resize({ width: COTE_MINIATURE, height: COTE_MINIATURE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 70 })
    .toBuffer();

  return { original, miniature };
}

module.exports = { preparerImage };
