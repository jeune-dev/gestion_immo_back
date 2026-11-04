'use strict';

/**
 * Reprend les données financières antérieures aux règles de cohérence.
 * Sans option, il n'écrit RIEN et affiche ce qu'il ferait.
 *
 *   npm run rattrapage:coherence
 *   npm run rattrapage:coherence -- --proprietaire=<uuid>
 *   npm run rattrapage:coherence -- --appliquer
 *   npm run rattrapage:coherence -- --appliquer --imputer-retenues
 *
 * --imputer-retenues solde les postes ouverts avec les anciennes retenues pour
 * impayés : quittances générées et locataires prévenus.
 * Sauvegardez la base avant --appliquer.
 */
require('dotenv').config();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
const connues = /^--(appliquer|imputer-retenues|proprietaire=.+)$/;
const inconnue = args.find((a) => !connues.test(a));
const ownerId = args.find((a) => a.startsWith('--proprietaire='))?.split('=')[1] || null;
if (inconnue || (ownerId && !UUID.test(ownerId))) {
  console.error(`Option invalide : ${inconnue || ownerId}`);
  process.exit(2);
}
const ecrire = args.includes('--appliquer');
const imputerRetenues = args.includes('--imputer-retenues');
if (imputerRetenues && !ecrire) {
  console.error('--imputer-retenues demande aussi --appliquer.');
  process.exit(2);
}

const { analyser, appliquer } = require('../src/database/rattrapageCoherence.js');
const sequelize = require('../src/config/db.js');

const total = (lignes) => lignes.reduce((s, l) => s + Number(l.amount), 0);

(async () => {
  const a = await analyser({ ownerId });
  console.log('Analyse');
  console.table({
    'Dépenses à créer': { nombre: a.factures_a_creer.length, montant: total(a.factures_a_creer) },
    'Dépenses manuelles à rattacher': { nombre: a.factures_a_rattacher.length, montant: total(a.factures_a_rattacher) },
    'Retenues sans sortie de caisse': { nombre: a.retenues_sans_sortie.length },
    'Retenues pour impayés non imputées': { nombre: a.retenues_non_imputees.length },
  });
  console.log('À traiter par le propriétaire (jamais modifié par ce script)');
  console.table({
    'Groupes de factures en double': { nombre: a.doublons.length },
    'Factures avec plusieurs dépenses possibles': { nombre: a.factures_ambigues.length },
    'Factures sans provision déduite': { nombre: a.provisions_non_deduites.length },
  });
  if (a.doublons.length) console.log('Doublons :', JSON.stringify(a.doublons.map((d) => d.ids)));
  if (a.factures_ambigues.length) console.log('Ambiguës :', JSON.stringify(a.factures_ambigues.map((f) => ({ facture: f.id, depenses: f.candidates }))));
  if (a.provisions_non_deduites.length) {
    console.log('Provisions :', JSON.stringify(a.provisions_non_deduites.map((f) => ({ facture: f.id, annulable: !f.charge_encaissee }))));
  }

  if (!ecrire) {
    console.log('Aucune écriture. Relancez avec --appliquer après une sauvegarde de la base.');
  } else {
    const r = await appliquer({ ownerId, imputerRetenues });
    console.log('Résultat', JSON.stringify(r, null, 2));
    if (r.erreurs.length) process.exitCode = 1;
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(async () => {
  await sequelize.close();
  // Connexions annexes (Redis, tâches) : rien ne doit retenir le script.
  process.exit();
});
