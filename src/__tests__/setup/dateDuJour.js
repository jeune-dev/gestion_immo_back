'use strict';

/**
 * Date du jour FIGÉE, à activer dans un fichier de test dont le jeu de données
 * repose sur le calendrier de septembre 2026 (helpers.js : bail au 2026-09-01,
 * paiement au 2026-09-05, « Loyer octobre 2026 »…) et dont les attentes
 * supposent qu'aujourd'hui tombe entre deux échéances : septembre « en
 * retard », octobre encore « à venir », 13 échéances d'horizon, rapprochement
 * par montant non ambigu. Sans ce gel, ces fichiers échouaient dès que le
 * calendrier réel dépassait fin septembre 2026.
 *
 * Usage : `require('<…>/setup/dateDuJour.js');` en PREMIÈRE ligne, avant tout
 * module applicatif (le remplacement doit précéder le premier chargement de
 * utils/dates.js).
 *
 * Seule `aujourdhui()` SANS argument est remplacée : la logique métier n'est
 * pas modifiée, l'heure système (jetons, expirations, now() SQL) reste réelle.
 * Les autres fichiers, qui comparent la date du jour aux horodatages réels de
 * la base, ne l'activent pas. `TEST_DATE_DU_JOUR=reelle` désactive le gel ;
 * toute autre valeur AAAA-MM-JJ le déplace.
 */
const DATE_REFERENCE = '2026-09-20';
const mockJour = process.env.TEST_DATE_DU_JOUR || DATE_REFERENCE;

if (mockJour !== 'reelle') {
  jest.mock('../../utils/dates.js', () => {
    const reel = jest.requireActual('../../utils/dates.js');
    return { ...reel, aujourdhui: (maintenant) => (maintenant === undefined ? mockJour : reel.aujourdhui(maintenant)) };
  });
}
