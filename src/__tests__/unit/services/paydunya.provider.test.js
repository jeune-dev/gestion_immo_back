'use strict';

const crypto = require('crypto');

/**
 * Adaptateur PayDunya (§ 31, § 51.2 mode A) — sans base ni réseau : `fetch`
 * simulé. API HTTP/JSON « Paiement Avec Redirection » :
 * developers.paydunya.com/doc/FR/http_json
 */

const IDS = { master_key: 'cle-principale-unitaire', private_key: 'test_private_unitaire', token: 'jeton-unitaire', mode: 'test' };
const LIVE = { ...IDS, private_key: 'live_private_unitaire', mode: 'live' };
const sha512 = (v) => crypto.createHash('sha512').update(v).digest('hex');

function charger() {
  let module;
  jest.isolateModules(() => { module = require('../../../infrastructure/paiement/paydunya.provider.js'); });
  return module;
}

const facture = (surcharges = {}) => ({
  response_code: '00',
  response_text: 'Transaction Found',
  hash: sha512(IDS.master_key),
  invoice: { token: 'test_abc123', total_amount: 350000, description: 'Loyer' },
  custom_data: { reference: 'TRX-ABC-1' },
  mode: 'test',
  status: 'completed',
  customer: { name: 'Awa', phone: '774563209', email: 'awa@exemple.sn' },
  ...surcharges,
});
const reponse = (status, json) => ({ ok: status < 300, status, json: async () => json });

describe('PayDunya — lecture et empreinte d’une IPN', () => {
  const { lireIpn, verifierEmpreinte, empreinteCle } = charger();

  test('empreinte = SHA-512 de la clé principale (documentation PayDunya), en hexadécimal', () => {
    expect(empreinteCle(IDS.master_key)).toBe(sha512(IDS.master_key));
    expect(empreinteCle(IDS.master_key)).toMatch(/^[0-9a-f]{128}$/);
  });

  test('corps imbriqué (`data`) et corps plat x-www-form-urlencoded (`data[hash]`) lus à l’identique', () => {
    const attendu = { hash: 'h', jeton: 'test_abc' };
    expect(lireIpn({ data: { hash: 'h', invoice: { token: 'test_abc' } } })).toEqual(attendu);
    expect(lireIpn({ 'data[hash]': 'h', 'data[invoice][token]': 'test_abc' })).toEqual(attendu);
  });

  test.each([
    ['corps absent', undefined],
    ['corps non objet', 'data=1'],
    ['jeton absent', { data: { hash: 'h' } }],
    ['jeton hostile (traversée d’URL)', { data: { hash: 'h', invoice: { token: '../../balance' } } }],
    ['jeton non textuel', { data: { hash: 'h', invoice: { token: { $ne: 1 } } } }],
    ['jeton démesuré', { data: { hash: 'h', invoice: { token: 'a'.repeat(101) } } }],
  ])('lecture défensive — %s → jeton null, jamais d’exception', (_l, corps) => {
    expect(lireIpn(corps).jeton).toBeNull();
  });

  test('empreinte : bonne clé acceptée (casse indifférente) ; autre clé, absente, non textuelle ou de longueur différente refusée', () => {
    const bonne = sha512(IDS.master_key);
    expect(verifierEmpreinte(IDS, bonne)).toBe(true);
    expect(verifierEmpreinte(IDS, bonne.toUpperCase())).toBe(true);
    expect(verifierEmpreinte(IDS, sha512('autre-cle'))).toBe(false);
    expect(verifierEmpreinte(IDS, null)).toBe(false);
    expect(verifierEmpreinte(IDS, 12345)).toBe(false);
    expect(verifierEmpreinte(IDS, 'abc')).toBe(false);
    expect(verifierEmpreinte({ ...IDS, master_key: undefined }, bonne)).toBe(false);
    expect(verifierEmpreinte(null, bonne)).toBe(false);
  });
});

describe('PayDunya — interpreterFacture (facture RELUE chez PayDunya)', () => {
  const { interpreterFacture } = charger();

  test('payée : événement, référence, montant entier, identifiant fournisseur, téléphone, jeton', () => {
    expect(interpreterFacture(IDS, facture())).toEqual({
      valide: true, evenement: 'confirme', reference: 'TRX-ABC-1', montant: 350000,
      idFournisseur: 'paydunya:test_abc123', telephone: '774563209', jeton: 'test_abc123',
    });
  });

  test.each([
    ['completed', 'confirme'], ['COMPLETED', 'confirme'], ['cancelled', 'annule'], ['failed', 'annule'],
    ['pending', 'ignore'], ['', 'ignore'], [undefined, 'ignore'],
  ])('statut « %s » → %s', (statut, evenement) => {
    expect(interpreterFacture(IDS, facture({ status: statut })).evenement).toBe(evenement);
  });

  test('référence absente des données personnalisées → null (retrouvée ensuite par le jeton) ; client absent → téléphone null', () => {
    expect(interpreterFacture(IDS, facture({ custom_data: undefined, customer: undefined }))).toMatchObject({ reference: null, telephone: null });
  });

  test('montant chaîne ou décimal arrondi au franc ; non numérique → NaN (écarté plus loin par le rapprochement)', () => {
    expect(interpreterFacture(IDS, facture({ invoice: { token: 't', total_amount: '1000.6' } })).montant).toBe(1001);
    expect(interpreterFacture(IDS, facture({ invoice: { token: 't', total_amount: 'abc' } })).montant).toBeNaN();
  });

  test('compte en PRODUCTION : une facture de TEST est refusée ; compte de test : tout mode accepté', () => {
    expect(interpreterFacture(LIVE, facture({ mode: 'test' }))).toEqual({ valide: false });
    expect(interpreterFacture(LIVE, facture({ mode: 'live' })).valide).toBe(true);
    expect(interpreterFacture(IDS, facture({ mode: 'live' })).valide).toBe(true);
  });

  test('facture sans jeton → invalide', () => {
    expect(interpreterFacture(IDS, facture({ invoice: {} }))).toEqual({ valide: false });
    expect(interpreterFacture(IDS, null)).toEqual({ valide: false });
  });
});

describe('PayDunya — verifierIpn : l’IPN n’est jamais crue, la facture est relue', () => {
  const origine = global.fetch;
  afterEach(() => { global.fetch = origine; });
  const ipn = (surcharges = {}) => ({ data: { hash: sha512(IDS.master_key), invoice: { token: 'test_abc123' }, status: 'completed', ...surcharges } });

  test('empreinte fausse → refus SANS appel réseau', async () => {
    const { verifierIpn } = charger();
    global.fetch = jest.fn();
    await expect(verifierIpn(IDS, ipn({ hash: sha512('mauvaise') }))).resolves.toEqual({ valide: false, motif: 'signature_invalide' });
    await expect(verifierIpn(IDS, { data: { invoice: { token: 'test_abc123' } } })).resolves.toMatchObject({ valide: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('jeton absent → refus sans appel réseau', async () => {
    const { verifierIpn } = charger();
    global.fetch = jest.fn();
    await expect(verifierIpn(IDS, { data: { hash: sha512(IDS.master_key) } })).resolves.toEqual({ valide: false, motif: 'jeton_absent' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('IPN annonçant « completed » pour une facture EN ATTENTE chez PayDunya → rien n’est confirmé', async () => {
    const { verifierIpn } = charger();
    global.fetch = jest.fn(async () => reponse(200, facture({ status: 'pending' })));
    const r = await verifierIpn(IDS, ipn({ status: 'completed', invoice: { token: 'test_abc123', total_amount: '999999999' } }));
    expect(r).toMatchObject({ valide: true, evenement: 'ignore', montant: 350000 });
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://app.paydunya.com/sandbox-api/v1/checkout-invoice/confirm/test_abc123');
    expect(options.method).toBe('GET');
    expect(options.headers).toMatchObject({
      'PAYDUNYA-MASTER-KEY': IDS.master_key, 'PAYDUNYA-PRIVATE-KEY': IDS.private_key, 'PAYDUNYA-TOKEN': IDS.token,
    });
  });

  test('montant et statut viennent de la facture relue, pas de l’IPN', async () => {
    const { verifierIpn } = charger();
    global.fetch = jest.fn(async () => reponse(200, facture()));
    const r = await verifierIpn(IDS, ipn({ invoice: { token: 'test_abc123', total_amount: '1' }, status: 'cancelled' }));
    expect(r).toMatchObject({ valide: true, evenement: 'confirme', montant: 350000, reference: 'TRX-ABC-1' });
    expect(r.facture.invoice.token).toBe('test_abc123');
  });

  test('facture relue différente de celle annoncée → refus', async () => {
    const { verifierIpn } = charger();
    global.fetch = jest.fn(async () => reponse(200, facture({ invoice: { token: 'test_autre', total_amount: 1 } })));
    await expect(verifierIpn(IDS, ipn())).resolves.toEqual({ valide: false, motif: 'facture_incoherente' });
  });

  test('facture inconnue chez PayDunya (response_code ≠ 00) ou PayDunya en panne → exception (le webhook répond 503)', async () => {
    const { verifierIpn } = charger();
    global.fetch = jest.fn(async () => reponse(200, { response_code: '1004', response_text: 'Invoice Not Found' }));
    await expect(verifierIpn(IDS, ipn())).rejects.toMatchObject({ message: 'Invoice Not Found', statut: 400 });
    global.fetch = jest.fn(async () => reponse(503, {}));
    await expect(verifierIpn(IDS, ipn())).rejects.toMatchObject({ statut: 503 });
  });

  test('compte en production : relecture sur l’API de production', async () => {
    const { verifierIpn } = charger();
    global.fetch = jest.fn(async () => reponse(200, facture({ mode: 'live' })));
    await verifierIpn(LIVE, { data: { hash: sha512(LIVE.master_key), invoice: { token: 'test_abc123' } } });
    expect(global.fetch.mock.calls[0][0]).toBe('https://app.paydunya.com/api/v1/checkout-invoice/confirm/test_abc123');
  });
});

describe('PayDunya — demanderPaiement (fetch simulé)', () => {
  const origine = global.fetch;
  afterEach(() => { global.fetch = origine; });
  const demande = {
    identifiants: IDS, reference: 'TRX-1', montant: 1000, libelle: 'L'.repeat(300), portefeuille: 'orange_money',
    urlIpn: 'https://api.test/ipn', urlSucces: 'https://app.test/ok', urlAnnulation: 'https://app.test/ko', boutique: 'Résidence Awa',
  };
  const cree = { response_code: '00', response_text: 'https://app.paydunya.com/sandbox-checkout/invoice/test_tok', description: 'Checkout Invoice Created', token: 'test_tok' };

  test('facture conforme à l’API : en-têtes, montant, canal restreint, référence en données personnalisées, URLs ; renvoie jeton et URL', async () => {
    const { demanderPaiement } = charger();
    global.fetch = jest.fn(async () => reponse(200, cree));
    await expect(demanderPaiement(demande)).resolves.toEqual({ jeton: 'test_tok', urlPaiement: cree.response_text });
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({
      'Content-Type': 'application/json', 'PAYDUNYA-MASTER-KEY': IDS.master_key, 'PAYDUNYA-PRIVATE-KEY': IDS.private_key, 'PAYDUNYA-TOKEN': IDS.token,
    });
    const corps = JSON.parse(options.body);
    expect(corps).toMatchObject({
      invoice: { total_amount: 1000, channels: ['orange-money-senegal'] },
      store: { name: 'Résidence Awa' },
      custom_data: { reference: 'TRX-1' },
      actions: { callback_url: 'https://api.test/ipn', return_url: 'https://app.test/ok', cancel_url: 'https://app.test/ko' },
    });
    expect(corps.invoice.description).toHaveLength(250);
  });

  test('Wave → canal wave-senegal ; portefeuille absent (abonnement) → tous les canaux du compte ; compte live → API de production', async () => {
    const { demanderPaiement } = charger();
    global.fetch = jest.fn(async () => reponse(200, cree));
    await demanderPaiement({ ...demande, portefeuille: 'wave' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).invoice.channels).toEqual(['wave-senegal']);
    await demanderPaiement({ ...demande, portefeuille: null, identifiants: LIVE });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).invoice.channels).toBeUndefined();
    expect(global.fetch.mock.calls[1][0]).toBe('https://app.paydunya.com/api/v1/checkout-invoice/create');
  });

  test('refus métier (response_code ≠ 00) → statut 400 ; HTTP 502 → statut 502 ; réponse sans jeton → 502', async () => {
    const { demanderPaiement } = charger();
    global.fetch = jest.fn(async () => reponse(200, { response_code: '1001', response_text: 'Invalid Masterkey Specified' }));
    await expect(demanderPaiement(demande)).rejects.toMatchObject({ message: 'Invalid Masterkey Specified', statut: 400 });
    global.fetch = jest.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('pas de JSON'); } }));
    await expect(demanderPaiement(demande)).rejects.toMatchObject({ statut: 502 });
    global.fetch = jest.fn(async () => reponse(200, { response_code: '00', response_text: 'https://x' }));
    await expect(demanderPaiement(demande)).rejects.toMatchObject({ statut: 502 });
  });
});
