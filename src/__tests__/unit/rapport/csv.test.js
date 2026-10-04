'use strict';

const { versCsv, cellule, BOM } = require('../../../modules/rapport/service/csv.js');
const exporter = require('../../../modules/rapport/service/export.js');
const { pourcentage } = require('../../../modules/rapport/service/indicateurs.js');

/**
 * Export CSV des rapports (§ 26) — fonctions pures : BOM UTF-8, séparateur
 * « ; », fins de ligne CRLF, échappement RFC 4180 et neutralisation de
 * l'injection de formules (OWASP « CSV injection »).
 */

describe('cellule', () => {
  test('valeurs vides et nombres', () => {
    expect(cellule(null)).toBe('');
    expect(cellule(undefined)).toBe('');
    expect(cellule(0)).toBe('0');
    expect(cellule(350000)).toBe('350000');
    // Un montant NÉGATIF reste un nombre : jamais préfixé.
    expect(cellule(-30000)).toBe('-30000');
    expect(cellule(12.5)).toBe('12.5');
    expect(cellule(true)).toBe('true');
  });

  test.each([
    ['=1+1', "'=1+1"],
    ['+221771234567', "'+221771234567"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=cmd', "'\t=cmd"],
    ['=HYPERLINK("http://x";"y")', "\"'=HYPERLINK(\"\"http://x\"\";\"\"y\"\")\""],
  ])('formule neutralisée : %j → %j', (entree, sortie) => {
    expect(cellule(entree)).toBe(sortie);
  });

  test('retour chariot en tête : neutralisé ET mis entre guillemets', () => {
    expect(cellule('\r=1')).toBe("\"'\r=1\"");
  });

  test('texte ordinaire intact ; accents conservés', () => {
    expect(cellule('Résidence Almadies')).toBe('Résidence Almadies');
    expect(cellule('a=b')).toBe('a=b');
    expect(cellule('Café 2+2')).toBe('Café 2+2');
  });

  test('séparateur, guillemets, sauts de ligne, espaces de bord → entre guillemets, guillemets doublés', () => {
    expect(cellule('a;b')).toBe('"a;b"');
    expect(cellule('dit "bonjour"')).toBe('"dit ""bonjour"""');
    expect(cellule('ligne1\nligne2')).toBe('"ligne1\nligne2"');
    expect(cellule(' espace')).toBe('" espace"');
    expect(cellule('fin ')).toBe('"fin "');
  });
});

describe('versCsv', () => {
  test('BOM, sections (titre, en-têtes, lignes, ligne vide), CRLF', () => {
    const csv = versCsv([
      { titre: 'Synthèse', entetes: ['Rubrique', 'Montant'], lignes: [['Loyers', 1000], ['Dépenses', -200]] },
      { titre: 'Vide', entetes: ['A'], lignes: [] },
    ]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(BOM).toBe('﻿');
    expect(csv.slice(1)).toBe('Synthèse\r\nRubrique;Montant\r\nLoyers;1000\r\nDépenses;-200\r\n\r\nVide\r\nA\r\n');
    expect(csv).not.toMatch(/[^\r]\n/);
  });

  test('aucune section : BOM seul', () => {
    expect(versCsv([])).toBe(BOM);
  });
});

describe('export des rapports : projection sans perte', () => {
  const entete = { periode: { du: '2026-09-01', au: '2026-09-30', jours: 30 }, building: null };

  test('financier : libellés et montants attendus, immeuble piégé neutralisé', () => {
    const csv = exporter.financier({
      ...entete,
      revenus: { loyers: 1, charges_recuperees: 2, autres_revenus: 3, total: 6 },
      depenses: { total: 4, par_categorie: [{ name: '=Piège', cash_group: 'travaux', nombre: 1, total: 4 }] },
      benefice_net: 2,
      impayes: { date: '2026-09-30', montant: 7 },
      charges: { factures_total: 8, refacturees_locataires: 5, recuperees_locataires: 1, reste_a_recouvrer: 4, a_charge_proprietaire: 3 },
      par_immeuble: [{ name: '@B', revenus: { loyers: 1, charges_recuperees: 2, autres_revenus: 3, total: 6 }, depenses: 4, benefice_net: 2, impayes: 7 }],
    });
    expect(csv).toContain('Tous les immeubles');
    expect(csv).toContain('Bénéfice net;2');
    expect(csv).toContain('Impayés au 2026-09-30;7');
    expect(csv).toContain("'=Piège;Travaux;1;4");
    expect(csv).toContain("'@B;1;2;3;6;4;2;7");
  });

  test('rentabilité : une ligne par appartement, dans l’ordre reçu', () => {
    const csv = exporter.rentabilite({
      entete: { ...entete, building: { id: 'x', name: 'Immeuble' } },
      rows: [
        { rang: 1, building_name: 'Immeuble', apartment_number: 'A1', loyers: 10, charges_recuperees: 0, autres_revenus: 0, revenus: 10, depenses: 0, resultat_net: 10, jours_occupation: 30, taux_occupation: 100 },
        { rang: 2, building_name: 'Immeuble', apartment_number: '+A2', loyers: 0, charges_recuperees: 0, autres_revenus: 0, revenus: 0, depenses: 5, resultat_net: -5, jours_occupation: 0, taux_occupation: 0 },
      ],
    });
    const lignes = csv.slice(1).split('\r\n');
    expect(lignes).toContain('1;Immeuble;A1;10;0;0;10;0;10;30;100');
    expect(lignes).toContain("2;Immeuble;'+A2;0;0;0;0;5;-5;0;0");
    expect(lignes).toContain('2026-09-01;2026-09-30;Immeuble');
  });
});

describe('pourcentage (indicateurs partagés tableau de bord / rapports)', () => {
  test('arrondi au dixième, dénominateur nul → 0', () => {
    expect(pourcentage(1, 3)).toBe(33.3);
    expect(pourcentage(2, 3)).toBe(66.7);
    expect(pourcentage(0, 0)).toBe(0);
    expect(pourcentage(5, 0)).toBe(0);
    expect(pourcentage(3, 3)).toBe(100);
  });
});
