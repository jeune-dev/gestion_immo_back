'use strict';

/**
 * Export CSV des rapports (§ 26), pensé pour Excel / LibreOffice en français :
 *   - UTF-8 AVEC BOM : sans lui, Excel lit les accents en Windows-1252 ;
 *   - séparateur `;` : la virgule est le séparateur décimal en français ;
 *   - guillemets doublés dans les valeurs entre guillemets (RFC 4180) ;
 *   - neutralisation de l'injection de formules (CSV injection, OWASP) : une
 *     valeur SAISIE par un utilisateur (nom d'immeuble, de locataire…) qui
 *     commence par = + - @ (ou tabulation / retour chariot) serait exécutée
 *     comme formule par le tableur ; elle est préfixée d'une apostrophe.
 *     Les NOMBRES ne sont pas concernés (un montant négatif reste un nombre).
 */

const BOM = '﻿';
const SEPARATEUR = ';';
const FIN_LIGNE = '\r\n';

function cellule(valeur) {
  if (valeur === null || valeur === undefined) return '';
  let texte = String(valeur);
  if (typeof valeur === 'string' && /^[=+\-@\t\r]/.test(texte)) texte = `'${texte}`;
  if (/[";\r\n]/.test(texte) || texte !== texte.trim()) texte = `"${texte.replace(/"/g, '""')}"`;
  return texte;
}

const ligne = (valeurs) => valeurs.map(cellule).join(SEPARATEUR);

/**
 * Document en SECTIONS (un rapport mêle synthèse et tableaux) : chaque section
 * = une ligne de titre, une ligne d'en-têtes, les lignes, puis une ligne vide.
 * @param {{ titre: string, entetes: string[], lignes: any[][] }[]} sections
 */
function versCsv(sections) {
  const sortie = [];
  for (const section of sections) {
    sortie.push(ligne([section.titre]));
    sortie.push(ligne(section.entetes));
    for (const valeurs of section.lignes) sortie.push(ligne(valeurs));
    sortie.push('');
  }
  return BOM + sortie.join(FIN_LIGNE);
}

module.exports = { versCsv, cellule, BOM };
