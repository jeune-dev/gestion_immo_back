'use strict';

const {
  Joi, uuid, telephone, email, motDePasse, nom, montant, montantPositif, dateIso, tri, recherche, pagination, paramId,
} = require('../../../validations/common.js');
const { normaliserTelephone, masquerTelephone } = require('../../../utils/telephone.js');

/**
 * Briques de validation partagées (validations/common.js) : toute entrée est
 * bornée et normalisée avant d'atteindre un service.
 */

const valider = (schema, valeur) => schema.validate(valeur, { convert: true });

describe('telephone (E.164, indicatif 221 par défaut)', () => {
  test.each([
    ['77 123 45 67', '+221771234567'],
    ['771234567', '+221771234567'],
    ['+221 77 123 45 67', '+221771234567'],
    ['00221771234567', '+221771234567'],
    ['221771234567', '+221771234567'],
    ['(77) 123-45-67', '+221771234567'],
    ['+33 6 12 34 56 78', '+33612345678'],
    ['0771234567', '+221771234567'],
  ])('« %s » → %s', (brut, attendu) => {
    expect(valider(telephone, brut).value).toBe(attendu);
    expect(normaliserTelephone(brut)).toBe(attendu);
  });

  test.each(['abc', '12', '+1', '+1234567890123456', '', '   '])('« %s » refusé', (brut) => {
    expect(valider(telephone.required(), brut).error).toBeDefined();
  });

  test('chaîne de plus de 25 caractères refusée avant toute normalisation', () => {
    expect(valider(telephone, `+221 ${'7'.repeat(30)}`).error).toBeDefined();
  });

  test('null / undefined → null ; masquage pour les journaux', () => {
    expect(normaliserTelephone(null)).toBeNull();
    expect(normaliserTelephone(undefined)).toBeNull();
    expect(masquerTelephone('+221771234567')).toBe('+22177•••••67');
    expect(masquerTelephone('123')).toBe('•••');
  });
});

describe('email', () => {
  test('mis en minuscules et rogné', () => {
    expect(valider(email, '  Awa.Fall@Test.SN ').value).toBe('awa.fall@test.sn');
  });
  test.each(['awa', 'awa@', '@test.sn', 'a b@test.sn', `${'a'.repeat(250)}@t.sn`])('« %s » refusé', (v) => {
    expect(valider(email, v).error).toBeDefined();
  });
});

describe('motDePasse', () => {
  test.each(['MotDePasse1', 'Abcdefg1', `Aa1${'x'.repeat(125)}`])('« %s » accepté', (v) => {
    expect(valider(motDePasse, v).error).toBeUndefined();
  });
  test.each(['Court1a', 'sansmajuscule1', 'SANSMINUSCULE1', 'SansChiffre', `Aa1${'x'.repeat(126)}`])('« %s » refusé', (v) => {
    expect(valider(motDePasse, v).error).toBeDefined();
  });
});

describe('nom', () => {
  test('rogné, 1 à 80 caractères', () => {
    expect(valider(nom, '  Diop  ').value).toBe('Diop');
    expect(valider(nom, 'a'.repeat(80)).error).toBeUndefined();
    expect(valider(nom, 'a'.repeat(81)).error).toBeDefined();
    expect(valider(nom, '   ').error).toBeDefined();
  });
});

describe('montants (FCFA entiers)', () => {
  test.each([[0, true], [1, true], [1_000_000_000_000, true], [1_000_000_000_001, false], [-1, false], [10.5, false], ['1000', true], ['abc', false], [Infinity, false]])(
    'montant %p → valide : %p',
    (v, ok) => { expect(valider(montant, v).error === undefined).toBe(ok); }
  );
  test('montantPositif : 0 refusé, 1 accepté', () => {
    expect(valider(montantPositif, 0).error).toBeDefined();
    expect(valider(montantPositif, 1).error).toBeUndefined();
  });
  test('conversion d’une chaîne numérique en nombre', () => {
    expect(valider(montant, '2500').value).toBe(2500);
  });
});

describe('dateIso (AAAA-MM-JJ)', () => {
  test.each(['2026-09-28', '2026-01-01', '2026-12-31', ' 2026-02-28 '])('« %s » acceptée', (v) => {
    expect(valider(dateIso, v).error).toBeUndefined();
  });
  test.each(['2026-13-01', '2026-00-10', '2026-01-32', '26-01-01', '2026/01/01', '2026-1-1', '2026-01-01T00:00:00Z', 'demain'])('« %s » refusée', (v) => {
    expect(valider(dateIso, v).error).toBeDefined();
  });
  test.each(['2026-02-29', '2026-02-30', '2026-04-31', '2100-02-29'])('« %s » : format valide mais date inexistante → refusée (sinon 500 PostgreSQL)', (v) => {
    expect(valider(dateIso, v).error.message).toMatch(/calendrier/);
  });
  test('29 février d’une année bissextile acceptée', () => {
    expect(valider(dateIso, '2028-02-29').error).toBeUndefined();
  });
  test('valeur renvoyée en CHAÎNE (pas de décalage de fuseau)', () => {
    expect(valider(dateIso, '2026-09-28').value).toBe('2026-09-28');
  });
});

describe('tri (liste blanche, anti injection ORDER BY)', () => {
  const schema = tri(['name', 'created_at']);
  test.each(['name', '-name', 'created_at', '-created_at'])('« %s » accepté', (v) => {
    expect(valider(schema, v).error).toBeUndefined();
  });
  test.each(['password_hash', '--name', 'name; DROP TABLE users', 'NAME', '+name', ''])('« %s » refusé', (v) => {
    expect(valider(schema, v).error).toBeDefined();
  });
});

describe('uuid, recherche, pagination, paramId', () => {
  test('uuid v4 accepté, texte et injection refusés', () => {
    expect(valider(uuid, '3f1c2b9e-1d2a-4c3b-9a8b-7c6d5e4f3a2b').error).toBeUndefined();
    expect(valider(uuid, "' OR 1=1 --").error).toBeDefined();
    expect(valider(uuid, '123').error).toBeDefined();
  });
  test('recherche bornée à 100 caractères, vide permise', () => {
    expect(valider(recherche, '').error).toBeUndefined();
    expect(valider(recherche, 'x'.repeat(100)).error).toBeUndefined();
    expect(valider(recherche, 'x'.repeat(101)).error).toBeDefined();
  });
  test('pagination : entiers ≥ 1', () => {
    const schema = Joi.object(pagination);
    expect(valider(schema, { page: '2', limit: '50' }).value).toEqual({ page: 2, limit: 50 });
    for (const v of [{ page: 0 }, { page: -1 }, { limit: 0 }, { limit: 'abc' }, { page: 1.5 }]) expect(valider(schema, v).error).toBeDefined();
    // Le plafond (100) est appliqué par pagination.middleware, pas par Joi.
    expect(valider(schema, { limit: 1000 }).error).toBeUndefined();
  });
  test('paramId exige un UUID', () => {
    expect(valider(paramId, { id: 'abc' }).error).toBeDefined();
    expect(valider(paramId, {}).error).toBeDefined();
  });
});
