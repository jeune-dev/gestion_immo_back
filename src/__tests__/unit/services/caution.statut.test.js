'use strict';

const { statutCaution, montantRetenu } = require('../../../modules/caution/service/caution.service.js');

// Le service charge le pool Sequelize (aucune connexion ouverte) : fermé pour que Jest termine proprement.
afterAll(() => require('../../../config/db.js').close());

/**
 * Statut de la caution (§ 55.2) et montant retenu (§ 55.3) — fonctions PURES,
 * testées de façon exhaustive : chaque statut est atteignable, chaque issue
 * de contestation produit le bon montant.
 */

const caution = (recu, retenu = 0, rendu = 0, attendu = 700000) => ({
  amount_expected: attendu, amount_received: recu, amount_withheld: retenu, amount_refunded: rendu,
});
const retenue = (contest = null, montant = 100000, ajuste = null) => ({ type: 'retenue', amount: montant, contest_status: contest, adjusted_amount: ajuste });

describe('montantRetenu (§ 55.3 issue de la contestation)', () => {
  test.each([
    ['versement', { type: 'versement', amount: 500000 }, 0],
    ['restitution', { type: 'restitution', amount: 500000 }, 0],
    ['retenue non contestée', retenue(null), 100000],
    ['retenue contestée en attente', retenue('conteste'), 100000],
    ['retenue maintenue', retenue('maintenue'), 100000],
    ['retenue annulée', retenue('annulee'), 0],
    ['retenue ajustée', retenue('ajustee', 100000, 40000), 40000],
    ['retenue ajustée à zéro', retenue('ajustee', 100000, 0), 0],
    ['retenue ajustée sans montant (donnée incomplète)', retenue('ajustee', 100000, null), 0],
  ])('%s', (_, mouvement, attendu) => {
    expect(montantRetenu(mouvement)).toBe(attendu);
  });
});

describe('statutCaution (§ 55.2) — pendant le bail', () => {
  test.each(['brouillon', 'actif', 'annule'])('bail « %s » : attendue → partiellement versée → détenue', (bail) => {
    expect(statutCaution(caution(0), [], bail)).toBe('attendue');
    expect(statutCaution(caution(1), [], bail)).toBe('partiellement_versee');
    expect(statutCaution(caution(699999), [], bail)).toBe('partiellement_versee');
    expect(statutCaution(caution(700000), [], bail)).toBe('detenue');
  });

  test('caution prévue à 0 et rien versé : statut « attendue » (aucune détention)', () => {
    expect(statutCaution(caution(0, 0, 0, 0), [], 'actif')).toBe('attendue');
  });
});

describe('statutCaution (§ 55.2) — fin de bail', () => {
  test.each(['termine', 'clos'])('bail « %s » : décompte', (bail) => {
    expect(statutCaution(caution(0), [], bail)).toBe('attendue');
    expect(statutCaution(caution(700000), [], bail)).toBe('restitution_en_cours');
    expect(statutCaution(caution(700000, 100000), [retenue()], bail)).toBe('retenue_partielle');
    expect(statutCaution(caution(700000, 0, 300000), [], bail)).toBe('restitution_en_cours');
    expect(statutCaution(caution(700000, 0, 700000), [], bail)).toBe('restituee');
    expect(statutCaution(caution(700000, 100000, 600000), [retenue()], bail)).toBe('restituee');
    // Tout retenu, rien rendu : retenue intégrale.
    expect(statutCaution(caution(700000, 700000, 0), [retenue(null, 700000)], bail)).toBe('retenue_partielle');
  });
});

describe('statutCaution (§ 55.2) — litige', () => {
  test.each([
    ['contestation en attente', 'conteste', 'litige'],
    ['retenue maintenue malgré la contestation', 'maintenue', 'litige'],
    ['retenue annulée : plus de litige', 'annulee', 'restitution_en_cours'],
    ['retenue ajustée : plus de litige', 'ajustee', 'retenue_partielle'],
  ])('%s', (_, contest, attendu) => {
    const retenu = contest === 'annulee' ? 0 : 50000;
    expect(statutCaution(caution(700000, retenu), [retenue(contest, 100000, 50000)], 'termine')).toBe(attendu);
  });

  test('le litige prime sur tout autre état, même pendant le bail ou une fois tout restitué', () => {
    expect(statutCaution(caution(700000), [retenue('conteste')], 'actif')).toBe('litige');
    expect(statutCaution(caution(700000, 100000, 600000), [retenue('maintenue')], 'clos')).toBe('litige');
  });

  test('une contestation sur un mouvement qui n’est pas une retenue est ignorée', () => {
    expect(statutCaution(caution(700000), [{ type: 'versement', amount: 700000, contest_status: 'conteste' }], 'actif')).toBe('detenue');
  });

  test('les sept statuts du § 55.2 sont tous atteignables', () => {
    const atteints = new Set([
      statutCaution(caution(0), [], 'actif'),
      statutCaution(caution(10), [], 'actif'),
      statutCaution(caution(700000), [], 'actif'),
      statutCaution(caution(700000), [], 'termine'),
      statutCaution(caution(700000, 1), [retenue(null, 1)], 'termine'),
      statutCaution(caution(700000, 0, 700000), [], 'termine'),
      statutCaution(caution(700000), [retenue('conteste')], 'termine'),
    ]);
    expect([...atteints].sort()).toEqual(['attendue', 'detenue', 'litige', 'partiellement_versee', 'restituee', 'restitution_en_cours', 'retenue_partielle']);
  });
});
