'use strict';

const {
  calculerRepartition, statutCharge, uniteParDefaut, nombreFr, pourcentFr,
} = require('../../../modules/charge/service/repartition.calcul.js');

/**
 * § 16–17 — calcul de répartition des factures communes (fonctions pures) :
 * chaque méthode, somme EXACTE des parts, explications lisibles.
 */
const apparts = (n, valeurs = []) => Array.from({ length: n }, (_, i) => ({
  apartment_id: `apt-${i + 1}`,
  numero: `A${String(i + 1).padStart(2, '0')}`,
  valeur: valeurs[i],
}));
const somme = (lignes) => lignes.reduce((s, l) => s + l.amount, 0);

describe('Répartition égale', () => {
  test('§ 16 : 720 000 FCFA sur 12 appartements → 12 × 60 000', () => {
    const r = calculerRepartition('egale', 720000, apparts(12));
    expect(r.lignes).toHaveLength(12);
    expect(r.lignes.every((l) => l.amount === 60000)).toBe(true);
    expect(somme(r.lignes)).toBe(720000);
    expect(r.lignes[0].explanation).toBe('720 000 FCFA ÷ 12 appartements = 60 000 FCFA');
    expect(r.lignes[0].share).toBe(0.08333333);
    expect(r.lignes[0].basis_value).toBe(1);
  });

  test('reste d’arrondi : 100 FCFA / 3 → 34 + 33 + 33, somme exacte et explication', () => {
    const r = calculerRepartition('egale', 100, apparts(3));
    expect(r.lignes.map((l) => l.amount)).toEqual([34, 33, 33]);
    expect(somme(r.lignes)).toBe(100);
    expect(r.lignes[0].explanation).toBe("100 FCFA ÷ 3 appartements = 33,33 FCFA, arrondi à 34 FCFA (écart d'arrondi réparti au franc près)");
  });

  test('un seul appartement : singulier', () => {
    const r = calculerRepartition('egale', 5000, apparts(1));
    expect(r.lignes[0].explanation).toBe('5 000 FCFA ÷ 1 appartement = 5 000 FCFA');
    expect(r.lignes[0].share).toBe(1);
  });

  test('sommes exactes sur des montants quelconques', () => {
    for (const [total, n] of [[1, 7], [999999, 13], [123457, 11], [720001, 12]]) {
      const r = calculerRepartition('egale', total, apparts(n));
      expect(somme(r.lignes)).toBe(total);
      const montants = r.lignes.map((l) => l.amount);
      expect(Math.max(...montants) - Math.min(...montants)).toBeLessThanOrEqual(1);
    }
  });
});

describe('Répartition selon la consommation', () => {
  test('proportionnelle, avec explication kWh et pourcentage', () => {
    const r = calculerRepartition('consommation', 720000, apparts(2, [34.5, 375.5]), { unite: 'kWh' });
    expect(somme(r.lignes)).toBe(720000);
    expect(r.lignes[0].amount).toBe(60585);
    expect(r.lignes[0].basis_value).toBe(34.5);
    expect(r.base_totale).toBe(410);
    expect(r.lignes[0].explanation).toBe('34,5 kWh sur 410 kWh (8,41 %) de 720 000 FCFA = 60 585 FCFA');
    expect(r.lignes[0].share).toBeCloseTo(34.5 / 410, 8);
  });

  test('consommation nulle d’un appartement → 0 FCFA ; consommation totale nulle → 422', () => {
    const r = calculerRepartition('consommation', 1000, apparts(2, [0, 12]), { unite: 'm³' });
    expect(r.lignes.map((l) => l.amount)).toEqual([0, 1000]);
    expect(r.lignes[0].explanation).toMatch(/aucune part, 0 FCFA/);
    expect(() => calculerRepartition('consommation', 1000, apparts(2, [0, 0]))).toThrow(expect.objectContaining({ statusCode: 422, code: 'BASE_NULLE' }));
  });

  test('valeur négative ou manquante refusée', () => {
    expect(() => calculerRepartition('consommation', 1000, apparts(2, [-1, 3]))).toThrow(expect.objectContaining({ statusCode: 422 }));
    expect(() => calculerRepartition('consommation', 1000, apparts(2, [undefined, 3]))).toThrow(expect.objectContaining({ statusCode: 422 }));
  });
});

describe('Répartition selon le coefficient (tantièmes)', () => {
  test('parts proportionnelles aux coefficients, somme exacte', () => {
    const r = calculerRepartition('coefficient', 100000, apparts(3, [1, 1.5, 2.5]));
    expect(r.lignes.map((l) => l.amount)).toEqual([20000, 30000, 50000]);
    expect(r.lignes[1].explanation).toBe('Coefficient 1,5 sur 5 (30,00 %) de 100 000 FCFA = 30 000 FCFA');
  });

  test('restes d’arrondi attribués de façon déterministe', () => {
    const a = calculerRepartition('coefficient', 1000, apparts(3, [1, 1, 1]));
    const b = calculerRepartition('coefficient', 1000, apparts(3, [1, 1, 1]));
    expect(a.lignes.map((l) => l.amount)).toEqual([334, 333, 333]);
    expect(b.lignes.map((l) => l.amount)).toEqual(a.lignes.map((l) => l.amount));
  });
});

describe("Répartition selon le nombre d'occupants", () => {
  test('logement vacant : 0 occupant, 0 FCFA, explication dédiée', () => {
    const lignes = apparts(3, [2, 0, 3]);
    lignes[1].vacant = true;
    const r = calculerRepartition('occupants', 50000, lignes);
    expect(r.lignes.map((l) => l.amount)).toEqual([20000, 0, 30000]);
    expect(r.lignes[0].explanation).toBe('2 occupants sur 5 au total (40,00 %) de 50 000 FCFA = 20 000 FCFA');
    expect(r.lignes[1].explanation).toBe('Aucun bail actif sur la période (logement vacant) : 0 occupant, 0 FCFA');
    expect(r.lignes[1].share).toBe(0);
  });

  test('aucun occupant → 422', () => {
    expect(() => calculerRepartition('occupants', 50000, apparts(2, [0, 0]))).toThrow(expect.objectContaining({ statusCode: 422, code: 'BASE_NULLE' }));
  });
});

describe('Montant personnalisé', () => {
  test('somme égale au total : montants repris tels quels', () => {
    const r = calculerRepartition('personnalise', 100000, apparts(2, [40000, 60000]));
    expect(r.lignes.map((l) => l.amount)).toEqual([40000, 60000]);
    expect(r.lignes[0].share).toBe(0.4);
    expect(r.lignes[0].explanation).toBe('Montant personnalisé : 40 000 FCFA (40,00 % de 100 000 FCFA)');
  });

  test('somme différente du total → 422 avec l’écart', () => {
    expect(() => calculerRepartition('personnalise', 100000, apparts(2, [40000, 59999])))
      .toThrow(expect.objectContaining({ statusCode: 422, code: 'SOMME_DIFFERENTE_DU_TOTAL' }));
    try {
      calculerRepartition('personnalise', 100000, apparts(2, [40000, 60500]));
    } catch (e) {
      expect(e.details[0]).toMatch(/écart : 500 FCFA/);
    }
  });

  test('montant non entier refusé', () => {
    expect(() => calculerRepartition('personnalise', 100, apparts(2, [50.5, 49.5]))).toThrow(expect.objectContaining({ code: 'MONTANT_NON_ENTIER' }));
  });
});

describe('Contrôles communs', () => {
  test('aucun appartement, doublon, montant invalide, méthode inconnue', () => {
    expect(() => calculerRepartition('egale', 1000, [])).toThrow(expect.objectContaining({ code: 'AUCUN_APPARTEMENT' }));
    expect(() => calculerRepartition('egale', 1000, [{ apartment_id: 'x' }, { apartment_id: 'x' }])).toThrow(expect.objectContaining({ code: 'APPARTEMENT_EN_DOUBLE' }));
    expect(() => calculerRepartition('egale', 0, apparts(2))).toThrow(expect.objectContaining({ statusCode: 422 }));
    expect(() => calculerRepartition('surface', 1000, apparts(2, [1, 1]))).toThrow(expect.objectContaining({ code: 'METHODE_INCONNUE' }));
  });

  test('parts toujours dans [0, 1] et somme exacte sur des poids aléatoires', () => {
    for (let k = 0; k < 50; k += 1) {
      const n = 1 + (k % 17);
      const poids = Array.from({ length: n }, (_, i) => ((i * 7919 + k * 104729) % 1000) / 10 + 0.1);
      const total = 1 + ((k * 7777777) % 5_000_000);
      const r = calculerRepartition('consommation', total, apparts(n, poids));
      expect(somme(r.lignes)).toBe(total);
      expect(r.lignes.every((l) => l.share >= 0 && l.share <= 1 && Number.isInteger(l.amount))).toBe(true);
    }
  });

  test('formats français', () => {
    expect(nombreFr(1250.75)).toBe('1 250,75');
    expect(nombreFr(34.5)).toBe('34,5');
    expect(pourcentFr(34.5 / 410)).toBe('8,41 %');
    expect(uniteParDefaut('electricite')).toBe('kWh');
    expect(uniteParDefaut('eau')).toBe('m³');
    expect(uniteParDefaut('nettoyage')).toBe('unités');
  });
});

describe('statutCharge', () => {
  const base = { amount: 60000, amount_paid: 0, due_date: '2026-10-10', cancelled_at: null };
  test.each([
    [{}, '2026-10-01', 'a_payer'],
    [{}, '2026-10-10', 'a_payer'],
    [{}, '2026-10-11', 'en_retard'],
    [{ amount_paid: 10000 }, '2026-10-01', 'partiellement_paye'],
    [{ amount_paid: 10000 }, '2026-10-11', 'en_retard'],
    [{ amount_paid: 60000 }, '2026-12-01', 'paye'],
    [{ cancelled_at: new Date() }, '2026-12-01', 'annule'],
  ])('%j au %s → %s', (surcharge, jour, attendu) => {
    expect(statutCharge({ ...base, ...surcharge }, jour)).toBe(attendu);
  });

  test('délai de grâce respecté', () => {
    expect(statutCharge(base, '2026-10-12', 3)).toBe('a_payer');
    expect(statutCharge(base, '2026-10-14', 3)).toBe('en_retard');
  });
});
