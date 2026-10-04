'use strict';

const crypto = require('crypto');
const { verifierSignature, interpreterEvenement } = require('../../../infrastructure/paiement/wave.provider.js');
const { comparerTempsConstant } = require('../../../infrastructure/paiement/signature.js');

/**
 * Wave Checkout (§ 51.2 mode A) et comparaison de signatures — sans base ni réseau.
 */

const IDS = { api_key: 'wave-cle', webhook_secret: 'wave-secret-unitaire' };
const MAINTENANT = Date.UTC(2026, 8, 28, 12, 0, 0);
const T = Math.floor(MAINTENANT / 1000);
const corps = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: { client_reference: 'TRX-1', amount: '350000' } }));
const hmac = (t, brut = corps, secret = IDS.webhook_secret) => crypto.createHmac('sha256', secret).update(`${t}${brut.toString('utf8')}`).digest('hex');

describe('Wave — verifierSignature', () => {
  test('signature valide sur le corps BRUT', () => {
    expect(verifierSignature(IDS, corps, `t=${T},v1=${hmac(T)}`, MAINTENANT)).toBe(true);
  });

  test('plusieurs v1 (rotation du secret) : une seule valide suffit ; espaces tolérés', () => {
    expect(verifierSignature(IDS, corps, `t=${T}, v1=${'0'.repeat(64)}, v1=${hmac(T)}`, MAINTENANT)).toBe(true);
    expect(verifierSignature(IDS, corps, `t=${T},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`, MAINTENANT)).toBe(false);
  });

  test('tolérance de 5 minutes : 299 s acceptées, 301 s refusées (passé et futur) — anti-rejeu', () => {
    expect(verifierSignature(IDS, corps, `t=${T - 299},v1=${hmac(T - 299)}`, MAINTENANT)).toBe(true);
    expect(verifierSignature(IDS, corps, `t=${T - 301},v1=${hmac(T - 301)}`, MAINTENANT)).toBe(false);
    expect(verifierSignature(IDS, corps, `t=${T + 301},v1=${hmac(T + 301)}`, MAINTENANT)).toBe(false);
  });

  test.each([
    ['corps modifié d’un octet', Buffer.from(corps.toString().replace('350000', '350001')), `t=${T},v1=${hmac(T)}`],
    ['horodatage modifié', corps, `t=${T + 1},v1=${hmac(T)}`],
    ['mauvais secret', corps, `t=${T},v1=${hmac(T, corps, 'autre')}`],
    ['en-tête absent', corps, undefined],
    ['en-tête non texte', corps, 42],
    ['sans horodatage', corps, `v1=${hmac(T)}`],
    ['sans v1', corps, `t=${T}`],
    ['v0 seulement', corps, `t=${T},v0=${hmac(T)}`],
    ['corps absent', null, `t=${T},v1=${hmac(T)}`],
    ['horodatage non numérique sans signature valide', corps, `t=abc,v1=${'0'.repeat(64)}`],
  ])('refus — %s', (_l, brut, entete) => {
    expect(verifierSignature(IDS, brut, entete, MAINTENANT)).toBe(false);
  });

  test('refus sans secret configuré', () => {
    expect(verifierSignature({ api_key: 'x' }, corps, `t=${T},v1=${hmac(T)}`, MAINTENANT)).toBe(false);
    expect(verifierSignature(null, corps, `t=${T},v1=${hmac(T)}`, MAINTENANT)).toBe(false);
  });

  test('CORRECTIF anti-rejeu : horodatage non numérique (NaN échappait à la fenêtre), double ou corps vide → refus, même bien signé', () => {
    expect(verifierSignature(IDS, corps, `t=abc,v1=${hmac('abc')}`, MAINTENANT)).toBe(false);
    expect(verifierSignature(IDS, corps, `t=${T}abc,v1=${hmac(`${T}abc`)}`, MAINTENANT)).toBe(false);
    expect(verifierSignature(IDS, corps, `t=${T},t=1,v1=${hmac(T)}`, MAINTENANT)).toBe(false);
    const vide = Buffer.alloc(0);
    expect(verifierSignature(IDS, vide, `t=${T},v1=${hmac(T, vide)}`, MAINTENANT)).toBe(false);
  });
});

describe('Wave — interpreterEvenement', () => {
  test('session réussie → confirmé, identifiant de transaction préféré à l’id de session', () => {
    expect(interpreterEvenement({ type: 'checkout.session.completed', data: { id: 'cos_1', client_reference: 'TRX-1', amount: '350000.4', payment_status: 'succeeded', transaction_id: 'T_9', sender_mobile: '+221770000000' } }))
      .toEqual({ evenement: 'confirme', reference: 'TRX-1', montant: 350000, idFournisseur: 'wave:T_9', telephone: '+221770000000', portefeuille: 'wave' });
  });

  test('sans transaction_id : identifiant de session ; sans aucun : null', () => {
    expect(interpreterEvenement({ type: 'checkout.session.completed', data: { id: 'cos_1', payment_status: 'succeeded' } }).idFournisseur).toBe('wave:cos_1');
    expect(interpreterEvenement({ type: 'checkout.session.completed', data: { payment_status: 'succeeded' } }).idFournisseur).toBeNull();
  });

  test('session « completed » non réussie → ignoré ; échec → annulé ; autre type → ignoré', () => {
    expect(interpreterEvenement({ type: 'checkout.session.completed', data: { payment_status: 'processing' } }).evenement).toBe('ignore');
    expect(interpreterEvenement({ type: 'checkout.session.payment_failed', data: { client_reference: 'TRX-1' } }).evenement).toBe('annule');
    expect(interpreterEvenement({ type: 'merchant.payment_received', data: {} }).evenement).toBe('ignore');
  });

  test('événement vide ou sans données : champs nuls, jamais d’exception', () => {
    expect(interpreterEvenement(null)).toEqual({ evenement: 'ignore', reference: null, montant: null, idFournisseur: null, telephone: null, portefeuille: 'wave' });
    expect(interpreterEvenement({ type: 'checkout.session.completed' }).montant).toBeNull();
  });
});

describe('comparerTempsConstant', () => {
  test('égalité stricte', () => {
    expect(comparerTempsConstant('abc123', 'abc123')).toBe(true);
    expect(comparerTempsConstant('abc123', 'abc124')).toBe(false);
  });

  test.each([
    ['longueurs différentes', 'abc', 'abcd'],
    ['attendu vide', '', ''],
    ['reçu vide', 'abc', ''],
    ['reçu non texte', 'abc', 123],
    ['attendu non texte', null, 'abc'],
    ['reçu undefined', 'abc', undefined],
    ['objet', 'abc', { toString: () => 'abc' }],
  ])('refus sans exception — %s', (_l, a, b) => {
    expect(() => comparerTempsConstant(a, b)).not.toThrow();
    expect(comparerTempsConstant(a, b)).toBe(false);
  });

  test('caractères multi-octets : comparés octet par octet', () => {
    expect(comparerTempsConstant('é', 'é')).toBe(true);
    expect(comparerTempsConstant('é', 'e')).toBe(false);
  });
});
