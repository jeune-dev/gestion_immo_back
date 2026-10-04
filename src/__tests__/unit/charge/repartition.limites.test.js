'use strict';

const {
  calculerRepartition, statutCharge, uniteParDefaut, nombreFr, pourcentFr, arrondirPart,
} = require('../../../modules/charge/service/repartition.calcul.js');
const { repartirProportionnellement, formatFcfa } = require('../../../utils/montants.js');

/**
 * § 16–17 — cas LIMITES du calcul de répartition (compléments de
 * unit/services/repartition.test.js) : très grands montants, poids minuscules,
 * égalités de restes, parts nulles, arrondis des parts et des pourcentages,
 * refus explicites. Aucune base de données.
 */

const lignes = (valeurs) => valeurs.map((v, i) => ({ apartment_id: `apt-${i + 1}`, numero: `N${i + 1}`, valeur: v }));
const somme = (r) => r.lignes.reduce((s, l) => s + l.amount, 0);
const codeErreur = (fn) => {
  try { fn(); } catch (e) { return e.code; }
  return null;
};

describe('Sommes TOUJOURS exactes', () => {
  test('très grand montant (1 000 milliards) sur 7 appartements égaux', () => {
    const r = calculerRepartition('egale', 1_000_000_000_000, lignes([1, 1, 1, 1, 1, 1, 1]));
    expect(somme(r)).toBe(1_000_000_000_000);
    expect(r.lignes.every((l) => Number.isInteger(l.amount))).toBe(true);
  });

  test('1 FCFA sur 3 : le franc va au premier (ordre d’entrée, déterministe)', () => {
    expect(calculerRepartition('egale', 1, lignes([1, 1, 1])).lignes.map((l) => l.amount)).toEqual([1, 0, 0]);
    expect(calculerRepartition('egale', 2, lignes([1, 1, 1])).lignes.map((l) => l.amount)).toEqual([1, 1, 0]);
  });

  test('restes égaux : attribution stable, identique d’un calcul à l’autre', () => {
    const a = calculerRepartition('coefficient', 10, lignes([1, 1, 1, 1, 1, 1])).lignes.map((l) => l.amount);
    const b = calculerRepartition('coefficient', 10, lignes([1, 1, 1, 1, 1, 1])).lignes.map((l) => l.amount);
    expect(a).toEqual(b);
    expect(a).toEqual([2, 2, 2, 2, 1, 1]);
  });

  test('plus fort reste d’abord : 100 sur [1, 2, 3.5] → 15 + 31 + 54', () => {
    const r = calculerRepartition('consommation', 100, lignes([1, 2, 3.5]));
    expect(r.lignes.map((l) => l.amount)).toEqual([15, 31, 54]);
    expect(somme(r)).toBe(100);
  });

  test('poids minuscules (0,0001) face à un gros poids : sommes exactes, parts nulles possibles', () => {
    const r = calculerRepartition('consommation', 1000, lignes([0.0001, 0.0001, 1000]));
    expect(somme(r)).toBe(1000);
    expect(r.lignes[2].amount).toBe(1000);
    expect(r.lignes[0].amount).toBe(0);
  });

  test('balayage : 200 combinaisons aléatoires (graine fixe) → somme exacte, écart au prorata < 1 FCFA', () => {
    let graine = 42;
    const alea = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
    for (let k = 0; k < 200; k += 1) {
      const n = 1 + Math.floor(alea() * 15);
      const poids = Array.from({ length: n }, () => Math.round(alea() * 10000) / 100);
      if (poids.every((x) => x === 0)) poids[0] = 1;
      const total = 1 + Math.floor(alea() * 5_000_000);
      const r = calculerRepartition('coefficient', total, lignes(poids));
      expect(somme(r)).toBe(total);
      const base = poids.reduce((a, b) => a + b, 0);
      r.lignes.forEach((l, i) => expect(Math.abs(l.amount - (total * poids[i]) / base)).toBeLessThan(1));
    }
  });

  test('repartirProportionnellement : refus explicites (total négatif ou non entier, poids invalides)', () => {
    expect(() => repartirProportionnellement(-1, [1])).toThrow(RangeError);
    expect(() => repartirProportionnellement(10.5, [1])).toThrow(RangeError);
    expect(() => repartirProportionnellement(10, [])).toThrow(RangeError);
    expect(() => repartirProportionnellement(10, [0, 0])).toThrow(RangeError);
    expect(() => repartirProportionnellement(10, [1, NaN])).toThrow(RangeError);
    expect(() => repartirProportionnellement(10, [1, -1])).toThrow(RangeError);
    expect(repartirProportionnellement(0, [1, 2])).toEqual([0, 0]);
  });
});

describe('Parts (share) et base de calcul', () => {
  test('part arrondie à 8 décimales, somme des parts ≈ 1', () => {
    const r = calculerRepartition('egale', 1000, lignes([1, 1, 1]));
    expect(r.lignes.map((l) => l.share)).toEqual([0.33333333, 0.33333333, 0.33333333]);
    expect(arrondirPart(2 / 3)).toBe(0.66666667);
    const c = calculerRepartition('coefficient', 999, lignes([3, 7, 11, 13]));
    expect(c.lignes.reduce((s, l) => s + l.share, 0)).toBeCloseTo(1, 6);
    expect(c.base_totale).toBe(34);
  });

  test('personnalisé : base = total, parts = montant / total ; zéros admis', () => {
    const r = calculerRepartition('personnalise', 1000, lignes([0, 1000, 0]));
    expect(r.base_totale).toBe(1000);
    expect(r.lignes.map((l) => [l.amount, l.share])).toEqual([[0, 0], [1000, 1], [0, 0]]);
    expect(r.lignes[0].explanation).toBe(`Montant personnalisé : ${formatFcfa(0)} (0,00 % de ${formatFcfa(1000)})`);
  });
});

describe('Explications (§ 17) : ne citent que des totaux et la ligne elle-même', () => {
  test('aucune explication ne mentionne un autre appartement', () => {
    const r = calculerRepartition('occupants', 90000, lignes([2, 0, 1]).map((l, i) => ({ ...l, vacant: i === 1 })));
    for (const l of r.lignes) {
      for (const autre of r.lignes.filter((x) => x !== l)) expect(l.explanation).not.toContain(autre.numero);
    }
    expect(r.lignes[1].explanation).toBe('Aucun bail actif sur la période (logement vacant) : 0 occupant, 0 FCFA');
    expect(r.lignes[0].explanation).toBe(`2 occupants sur 3 au total (66,67 %) de ${formatFcfa(90000)} = ${formatFcfa(60000)}`);
  });

  test('0 occupant d’un appartement OCCUPÉ (surcharge explicite) : explication générique, pas « vacant »', () => {
    const r = calculerRepartition('occupants', 100, [{ apartment_id: 'a', numero: 'A', valeur: 0, vacant: false }, { apartment_id: 'b', numero: 'B', valeur: 1 }]);
    expect(r.lignes[0].explanation).toMatch(/aucune part, 0 FCFA/);
  });

  test('coefficient décimal et unité de consommation personnalisée', () => {
    const r = calculerRepartition('coefficient', 1000, lignes([1.25, 3.75]));
    expect(r.lignes[0].explanation).toBe(`Coefficient 1,25 sur 5 (25,00 %) de ${formatFcfa(1000)} = ${formatFcfa(250)}`);
    const c = calculerRepartition('consommation', 1000, lignes([1, 3]), { unite: 'm³' });
    expect(c.lignes[1].explanation).toBe(`3 m³ sur 4 m³ (75,00 %) de ${formatFcfa(1000)} = ${formatFcfa(750)}`);
  });
});

describe('Refus (422, codes stables)', () => {
  test.each([
    ['total nul', () => calculerRepartition('egale', 0, lignes([1])), 'REPARTITION_INVALIDE'],
    ['total décimal', () => calculerRepartition('egale', 10.5, lignes([1])), 'REPARTITION_INVALIDE'],
    ['total texte', () => calculerRepartition('egale', '100', lignes([1])), 'REPARTITION_INVALIDE'],
    ['aucune ligne', () => calculerRepartition('egale', 100, []), 'AUCUN_APPARTEMENT'],
    ['lignes absentes', () => calculerRepartition('egale', 100, null), 'AUCUN_APPARTEMENT'],
    ['doublon', () => calculerRepartition('egale', 100, [{ apartment_id: 'x' }, { apartment_id: 'x' }]), 'APPARTEMENT_EN_DOUBLE'],
    ['valeur négative', () => calculerRepartition('consommation', 100, lignes([1, -1])), 'VALEUR_MANQUANTE'],
    ['valeur manquante', () => calculerRepartition('coefficient', 100, lignes([1, undefined])), 'VALEUR_MANQUANTE'],
    ['valeur infinie', () => calculerRepartition('coefficient', 100, lignes([Infinity])), 'VALEUR_MANQUANTE'],
    ['consommation totale nulle', () => calculerRepartition('consommation', 100, lignes([0, 0])), 'BASE_NULLE'],
    ['coefficients nuls', () => calculerRepartition('coefficient', 100, lignes([0])), 'BASE_NULLE'],
    ['aucun occupant', () => calculerRepartition('occupants', 100, lignes([0, 0])), 'BASE_NULLE'],
    ['personnalisé décimal', () => calculerRepartition('personnalise', 100, lignes([50.5, 49.5])), 'MONTANT_NON_ENTIER'],
    ['personnalisé somme trop grande', () => calculerRepartition('personnalise', 100, lignes([60, 41])), 'SOMME_DIFFERENTE_DU_TOTAL'],
    ['méthode inconnue', () => calculerRepartition('tirage_au_sort', 100, lignes([1])), 'METHODE_INCONNUE'],
  ])('%s → %s', (_cas, fn, code) => {
    expect(codeErreur(fn)).toBe(code);
  });
});

describe('Formats et statuts', () => {
  test('nombreFr : milliers, décimales bornées, négatifs', () => {
    expect(nombreFr(1234567.891)).toBe('1 234 567,891');
    expect(nombreFr(0.00004)).toBe('0');
    expect(nombreFr(-1500.5)).toBe('-1 500,5');
    expect(nombreFr(2 / 3, 2)).toBe('0,67');
    expect(nombreFr(1000)).toBe('1 000');
  });

  test('pourcentFr : toujours deux décimales', () => {
    expect(pourcentFr(1)).toBe('100,00 %');
    expect(pourcentFr(0)).toBe('0,00 %');
    expect(pourcentFr(1 / 3)).toBe('33,33 %');
    expect(pourcentFr(0.00006)).toBe('0,01 %');
  });

  test('unité par défaut selon le type de charge', () => {
    expect(uniteParDefaut('electricite')).toBe('kWh');
    expect(uniteParDefaut('eau')).toBe('m³');
    expect(uniteParDefaut('gardiennage')).toBe('unités');
  });

  test('statutCharge : annulée prioritaire, payée dès couverture, retard au-delà de la grâce, jour d’échéance non en retard', () => {
    const c = { amount: 1000, amount_paid: 0, due_date: '2026-10-05' };
    expect(statutCharge({ ...c, cancelled_at: new Date(), amount_paid: 1000 }, '2026-12-01')).toBe('annule');
    expect(statutCharge({ ...c, amount_paid: 1000 }, '2027-01-01')).toBe('paye');
    expect(statutCharge({ ...c, amount_paid: 1500 }, '2026-10-01')).toBe('paye');
    expect(statutCharge(c, '2026-10-05')).toBe('a_payer');
    expect(statutCharge(c, '2026-10-06')).toBe('en_retard');
    expect(statutCharge({ ...c, amount_paid: 1 }, '2026-10-05')).toBe('partiellement_paye');
    expect(statutCharge({ ...c, amount_paid: 1 }, '2026-10-06')).toBe('en_retard');
    expect(statutCharge(c, '2026-10-08', 3)).toBe('a_payer');
    expect(statutCharge(c, '2026-10-09', 3)).toBe('en_retard');
    // Montants arrivés en chaîne (BIGINT texte) : comparés comme des nombres.
    expect(statutCharge({ amount: '1000', amount_paid: '999', due_date: '2026-10-05' }, '2026-10-01')).toBe('partiellement_paye');
  });
});
