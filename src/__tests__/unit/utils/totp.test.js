'use strict';

const totp = require('../../../utils/totp.js');

/**
 * TOTP (RFC 6238) — vecteurs de test OFFICIELS de l'annexe B (HMAC-SHA1,
 * secret ASCII « 12345678901234567890 »), ramenés à 6 chiffres.
 */
const SECRET_RFC = totp.versBase32(Buffer.from('12345678901234567890'));

describe('TOTP — conformité RFC 6238', () => {
  test('Base32 : encodage du secret de la RFC et aller-retour', () => {
    expect(SECRET_RFC).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totp.depuisBase32(SECRET_RFC).toString()).toBe('12345678901234567890');
    expect(totp.depuisBase32('gezd gnbv')).toEqual(totp.depuisBase32('GEZDGNBV'));
    expect(totp.depuisBase32('ABC1')).toBeNull();
    expect(totp.depuisBase32('')).toBeNull();
  });

  test.each([
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'],
  ])('instant %i s → %s (annexe B)', (secondes, attendu) => {
    expect(totp.codePourPas(SECRET_RFC, Math.floor(secondes / 30))).toBe(attendu);
  });

  test('secret aléatoire de 160 bits, en Base32', () => {
    const s = totp.genererSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(totp.depuisBase32(s)).toHaveLength(20);
    expect(totp.genererSecret()).not.toBe(s);
  });
});

describe('TOTP — vérification', () => {
  const maintenant = 1234567890 * 1000;
  const pas = Math.floor(1234567890 / 30);

  test('code courant, précédent et suivant acceptés (dérive d’horloge) ; au-delà refusés', () => {
    expect(totp.verifier(SECRET_RFC, totp.codePourPas(SECRET_RFC, pas), { maintenant })).toBe(pas);
    expect(totp.verifier(SECRET_RFC, totp.codePourPas(SECRET_RFC, pas - 1), { maintenant })).toBe(pas - 1);
    expect(totp.verifier(SECRET_RFC, totp.codePourPas(SECRET_RFC, pas + 1), { maintenant })).toBe(pas + 1);
    expect(totp.verifier(SECRET_RFC, totp.codePourPas(SECRET_RFC, pas + 2), { maintenant })).toBeNull();
    expect(totp.verifier(SECRET_RFC, totp.codePourPas(SECRET_RFC, pas - 2), { maintenant })).toBeNull();
  });

  test('anti-rejeu : un pas déjà consommé (ou plus ancien) est refusé', () => {
    const code = totp.codePourPas(SECRET_RFC, pas);
    expect(totp.verifier(SECRET_RFC, code, { maintenant, dernierPas: pas })).toBeNull();
    expect(totp.verifier(SECRET_RFC, code, { maintenant, dernierPas: pas + 1 })).toBeNull();
    expect(totp.verifier(SECRET_RFC, code, { maintenant, dernierPas: pas - 1 })).toBe(pas);
  });

  test.each([['12345'], ['1234567'], ['abcdef'], [' 12345'], [123456], [null], [undefined]])('format refusé sans exception : %p', (code) => {
    expect(totp.verifier(SECRET_RFC, code, { maintenant })).toBeNull();
  });

  test('URI otpauth pour le QR code', () => {
    const uri = totp.uriOtpauth({ secret: SECRET_RFC, compte: 'admin@exemple.sn', emetteur: 'Gestion immobilière' });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Gestion%20immobili%C3%A8re%3Aadmin%40exemple\.sn\?/);
    expect(new URL(uri).searchParams.get('secret')).toBe(SECRET_RFC);
    expect(new URL(uri).searchParams.get('digits')).toBe('6');
    expect(new URL(uri).searchParams.get('period')).toBe('30');
  });
});
