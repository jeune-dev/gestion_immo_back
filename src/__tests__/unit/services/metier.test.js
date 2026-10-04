'use strict';

const { repartirProportionnellement, formatFcfa } = require('../../../utils/montants.js');
const { normaliserTelephone } = require('../../../utils/telephone.js');
const { ajouterMois, ecartJours, avecJour } = require('../../../utils/dates.js');
const { periodesAGenerer, statutA } = require('../../../modules/loyer/service/echeance.service.js');
const { statutCaution, montantRetenu } = require('../../../modules/caution/service/caution.service.js');
const { statutCharge } = require('../../../modules/paiement/service/allocation.service.js');
const { gabarit } = require('../../../modules/loyer/service/relance.service.js');
const { rendre, variablesInconnues } = require('../../../modules/bail/service/modeleBail.service.js');
const { TRAVAUX, verifierTransition } = require('../../../config/transitions.js');

// Les services chargent le pool Sequelize (aucune connexion ouverte ici) : on
// le ferme pour que Jest termine proprement.
afterAll(() => require('../../../config/db.js').close());

describe('Montants (FCFA entiers)', () => {
  test('§ 16 : 720 000 FCFA sur 12 appartements = 12 × 60 000', () => {
    expect(repartirProportionnellement(720000, Array(12).fill(1))).toEqual(Array(12).fill(60000));
  });

  test('le reste d’arrondi est distribué : la somme vaut toujours le total', () => {
    const parts = repartirProportionnellement(100, [1, 1, 1]);
    expect(parts).toEqual([34, 33, 33]);
    const poids = [3.5, 12.25, 7, 0, 1];
    const total = 987654;
    expect(repartirProportionnellement(total, poids).reduce((a, b) => a + b, 0)).toBe(total);
  });

  test('refuse un total non entier ou des poids nuls', () => {
    expect(() => repartirProportionnellement(10.5, [1])).toThrow();
    expect(() => repartirProportionnellement(10, [0, 0])).toThrow();
  });

  test('format d’affichage', () => {
    expect(formatFcfa(350000)).toBe('350 000 FCFA');
  });
});

describe('Téléphone (identifiant de connexion, destinataire WhatsApp)', () => {
  test.each([
    ['77 123 45 67', '+221771234567'],
    ['+221 77 123 45 67', '+221771234567'],
    ['00221771234567', '+221771234567'],
    ['221771234567', '+221771234567'],
    ['+33 6 12 34 56 78', '+33612345678'],
  ])('%s → %s', (brut, attendu) => expect(normaliserTelephone(brut)).toBe(attendu));

  test('valeur inexploitable → null', () => {
    expect(normaliserTelephone('abc')).toBeNull();
    expect(normaliserTelephone('')).toBeNull();
  });
});

describe('Dates calendaires', () => {
  test('31 janvier + 1 mois = fin février', () => {
    expect(ajouterMois('2027-01-31', 1)).toBe('2027-02-28');
    expect(ajouterMois('2028-01-31', 1)).toBe('2028-02-29');
  });
  test('écart et jour borné', () => {
    expect(ecartJours('2026-09-01', '2026-09-05')).toBe(4);
    expect(avecJour('2026-02-10', 31)).toBe('2026-02-28');
  });
});

describe('Échéances (§ 10, § 11)', () => {
  const bail = { start_date: '2026-09-01', end_date: null, periodicity: 'mensuel', due_day: 5, rent_amount: 350000, charges_amount: 0 };

  test('génération mensuelle jusqu’à l’horizon', () => {
    const p = periodesAGenerer(bail, null, '2026-11-30');
    expect(p.map((x) => x.period_start)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    expect(p[1]).toMatchObject({ due_date: '2026-10-05', amount_due: 350000, label: 'Loyer octobre 2026', period_end: '2026-10-31' });
  });

  test('trimestriel : montant × 3 ; reprise après la dernière période générée', () => {
    const p = periodesAGenerer({ ...bail, periodicity: 'trimestriel' }, '2026-09-01', '2027-06-30');
    expect(p[0]).toMatchObject({ period_start: '2026-12-01', period_end: '2027-02-28', amount_due: 1050000 });
  });

  test('dernière période coupée par la fin du bail : prorata au jour', () => {
    const p = periodesAGenerer({ ...bail, end_date: '2026-10-15' }, null, '2027-12-31');
    expect(p).toHaveLength(2);
    expect(p[1]).toMatchObject({ period_start: '2026-10-01', period_end: '2026-10-15', amount_due: Math.round(350000 * 15 / 31) });
  });

  test('statuts : à venir → à payer → en retard ; payé seulement si soldé', () => {
    const e = { amount_due: 350000, amount_paid: 0, due_date: '2026-10-05' };
    const reglages = { schedule_notice_days: 5, late_grace_days: 0 };
    expect(statutA(e, '2026-09-20', reglages)).toBe('a_venir');
    expect(statutA(e, '2026-10-01', reglages)).toBe('a_payer');
    expect(statutA(e, '2026-10-06', reglages)).toBe('en_retard');
    expect(statutA({ ...e, amount_paid: 100000 }, '2026-10-03', reglages)).toBe('partiellement_paye');
    expect(statutA({ ...e, amount_paid: 350000 }, '2026-12-01', reglages)).toBe('paye');
    expect(statutA({ ...e, cancelled_at: new Date() }, '2026-10-06', reglages)).toBe('annule');
  });

  test('charges refacturées : même logique', () => {
    expect(statutCharge({ amount: 60000, amount_paid: 60000, due_date: '2026-10-01' }, '2026-12-01')).toBe('paye');
    expect(statutCharge({ amount: 60000, amount_paid: 0, due_date: '2026-10-01' }, '2026-10-02')).toBe('en_retard');
  });
});

describe('Relances (§ 14, § 54.2)', () => {
  test('ton progressif selon le rang du retard', () => {
    expect(gabarit(-3, 0).evenement).toBe('rappel_avant_echeance');
    expect(gabarit(0, 0).evenement).toBe('echeance_jour');
    expect(gabarit(3, 1).evenement).toBe('retard_niveau_1');
    expect(gabarit(7, 2).evenement).toBe('retard_niveau_2');
    expect(gabarit(15, 3).evenement).toBe('retard_niveau_3');
    expect(gabarit(30, 4).evenement).toBe('retard_niveau_3');
  });
});

describe('Caution (§ 55)', () => {
  const base = { amount_expected: 700000, amount_received: 0, amount_withheld: 0, amount_refunded: 0 };

  test('pendant le bail : attendue → partiellement versée → détenue', () => {
    expect(statutCaution(base, [], 'actif')).toBe('attendue');
    expect(statutCaution({ ...base, amount_received: 300000 }, [], 'actif')).toBe('partiellement_versee');
    expect(statutCaution({ ...base, amount_received: 700000 }, [], 'actif')).toBe('detenue');
  });

  test('fin de bail : décompte, retenue partielle, restituée', () => {
    const verse = { ...base, amount_received: 700000 };
    expect(statutCaution(verse, [], 'termine')).toBe('restitution_en_cours');
    expect(statutCaution({ ...verse, amount_withheld: 100000 }, [], 'termine')).toBe('retenue_partielle');
    expect(statutCaution({ ...verse, amount_withheld: 100000, amount_refunded: 600000 }, [], 'termine')).toBe('restituee');
  });

  test('une contestation en cours ou maintenue = litige', () => {
    const r = { type: 'retenue', amount: 100000, contest_status: 'conteste' };
    expect(statutCaution({ ...base, amount_received: 700000 }, [r], 'termine')).toBe('litige');
    expect(statutCaution({ ...base, amount_received: 700000 }, [{ ...r, contest_status: 'maintenue' }], 'termine')).toBe('litige');
  });

  test('montant retenu selon l’issue de la contestation', () => {
    const r = { type: 'retenue', amount: 100000 };
    expect(montantRetenu(r)).toBe(100000);
    expect(montantRetenu({ ...r, contest_status: 'annulee' })).toBe(0);
    expect(montantRetenu({ ...r, contest_status: 'ajustee', adjusted_amount: 40000 })).toBe(40000);
  });
});

describe('Modèle de bail (§ 53)', () => {
  test('variables remplacées ; variable inconnue refusée', () => {
    expect(rendre('Loyer {{bail.loyer}} — {{ bien.numero }}', { 'bail.loyer': '350 000 FCFA', 'bien.numero': 'A07' }))
      .toBe('Loyer 350 000 FCFA — A07');
    expect(variablesInconnues('{{bail.loyer}} {{inconnue.variable}}')).toEqual(['inconnue.variable']);
    expect(() => rendre('{{inconnue.variable}}', {})).toThrow();
  });
});

describe('Transitions des travaux (§ 18)', () => {
  test('permises et interdites', () => {
    expect(() => verifierTransition(TRAVAUX, 'valide', 'en_cours', 'Le travail')).not.toThrow();
    expect(() => verifierTransition(TRAVAUX, 'signale', 'termine', 'Le travail')).toThrow(/Transition impossible/);
    expect(() => verifierTransition(TRAVAUX, 'termine', 'en_cours', 'Le travail')).toThrow();
  });
});
