'use strict';

const { gabarit, corps, TAILLE_LOT_DEFAUT } = require('../../../modules/loyer/service/relance.service.js');
const { formatFcfa } = require('../../../utils/montants.js');

/**
 * Relances (§ 14, § 54.2) — gabarits et textes (fonctions pures) : avant
 * l'échéance, le jour même, puis retards au ton PROGRESSIF (niveaux 1 à 3).
 */

const echeance = (surcharges = {}) => ({
  label: 'Loyer Octobre 2026', due_date: '2026-10-05', amount_due: 350000, amount_paid: 0, ...surcharges,
});

describe('gabarit', () => {
  test.each([
    [-7, 0, 'rappel_avant_echeance', 'Loyer bientôt exigible'],
    [-1, 0, 'rappel_avant_echeance', 'Loyer bientôt exigible'],
    [0, 0, 'echeance_jour', "Loyer exigible aujourd'hui"],
    [3, 1, 'retard_niveau_1', 'Loyer en retard'],
    [7, 2, 'retard_niveau_2', 'Loyer en retard'],
    [15, 3, 'retard_niveau_3', 'Dernier rappel : loyer impayé'],
    [30, 4, 'retard_niveau_3', 'Dernier rappel : loyer impayé'],
    [60, 9, 'retard_niveau_3', 'Dernier rappel : loyer impayé'],
  ])('décalage %i, rang %i → %s', (decalage, rang, evenement, titre) => {
    expect(gabarit(decalage, rang)).toEqual({ evenement, titre });
  });
});

describe('corps', () => {
  test('avant l’échéance : reste dû et date au format français, libellé en minuscules', () => {
    expect(corps(-3, echeance())).toBe(`Votre loyer octobre 2026 (${formatFcfa(350000)}) arrive à échéance le 05/10/2026.`);
  });

  test('le jour même', () => {
    expect(corps(0, echeance())).toBe(`Votre loyer octobre 2026 (${formatFcfa(350000)}) est exigible aujourd'hui.`);
  });

  test('en retard : nombre de jours et RESTE dû (paiement partiel déduit)', () => {
    expect(corps(7, echeance({ amount_paid: 100000 }))).toBe(`Votre loyer octobre 2026 présente un retard de 7 jours. Reste dû : ${formatFcfa(250000)}.`);
  });

  test('montants reçus en texte (BIGINT) : soustraction numérique, jamais une concaténation', () => {
    expect(corps(3, echeance({ amount_due: '350000', amount_paid: '50000' }))).toContain(formatFcfa(300000));
  });
});

test('taille de lot par défaut bornée et positive', () => {
  expect(Number.isInteger(TAILLE_LOT_DEFAUT)).toBe(true);
  expect(TAILLE_LOT_DEFAUT).toBeGreaterThan(0);
  expect(TAILLE_LOT_DEFAUT).toBeLessThanOrEqual(5000);
});
