'use strict';

const crypto = require('crypto');
const fs = require('fs');
const sharp = require('sharp');

afterAll(() => require('../../../config/db.js').close());

describe('WhatsApp Cloud API (§ 54)', () => {
  const wa = () => require('../../../infrastructure/whatsapp.service.js');
  const fetchOrigine = global.fetch;
  afterEach(() => {
    global.fetch = fetchOrigine;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_APP_SECRET;
  });

  test('signature X-Hub-Signature-256 vérifiée sur le corps BRUT, en temps constant', () => {
    process.env.WHATSAPP_APP_SECRET = 'secret-app';
    const corps = Buffer.from('{"entry":[]}');
    const bonne = `sha256=${crypto.createHmac('sha256', 'secret-app').update(corps).digest('hex')}`;
    expect(wa().verifierSignature(corps, bonne)).toBe(true);
    expect(wa().verifierSignature(Buffer.from('{"entry":[1]}'), bonne)).toBe(false);
    expect(wa().verifierSignature(corps, 'sha256=00')).toBe(false);
    expect(wa().verifierSignature(corps, undefined)).toBe(false);
    delete process.env.WHATSAPP_APP_SECRET;
    expect(wa().verifierSignature(corps, bonne)).toBe(false);
  });

  test('envoi d’un modèle : requête conforme à l’API Meta, identifiant retourné', async () => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    process.env.WHATSAPP_ACCESS_TOKEN = 'jeton';
    let appel;
    global.fetch = jest.fn(async (url, init) => {
      appel = { url, init: { ...init, body: JSON.parse(init.body) } };
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.X' }] }) };
    });
    const r = await wa().envoyerModele({ telephone: '+221771234567', modele: 'loyer_retard', langue: 'fr', parametres: ['octobre 2026', 3, '350 000 FCFA'] });
    expect(r).toEqual({ id: 'wamid.X' });
    expect(appel.url).toMatch(/graph\.facebook\.com\/v\d+\.\d+\/123\/messages$/);
    expect(appel.init.headers.Authorization).toBe('Bearer jeton');
    expect(appel.init.body).toMatchObject({ messaging_product: 'whatsapp', to: '221771234567', type: 'template', template: { name: 'loyer_retard', language: { code: 'fr' } } });
    expect(appel.init.body.template.components[0].parameters.map((p) => p.text)).toEqual(['octobre 2026', '3', '350 000 FCFA']);
  });

  test('refus de Meta et service non configuré : erreurs explicites', async () => {
    await expect(wa().envoyerModele({ telephone: '+221', modele: 'x', langue: 'fr', parametres: [] })).rejects.toThrow('non configuré');
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    process.env.WHATSAPP_ACCESS_TOKEN = 'jeton';
    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Template not approved' } }) }));
    await expect(wa().envoyerModele({ telephone: '+221771234567', modele: 'x', langue: 'fr', parametres: [] })).rejects.toThrow('Template not approved');
    expect(wa().STATUTS).toEqual({ sent: 'envoye', delivered: 'distribue', read: 'lu', failed: 'echec' });
  });
});

describe('notifications push FCM', () => {
  test('sans Firebase : ignoré proprement ; jetons morts purgés après envoi', async () => {
    jest.resetModules();
    const detruits = [];
    jest.doMock('../../../models/index.js', () => ({
      DeviceToken: {
        findAll: async () => [{ id: 'd1', token: 'vivant' }, { id: 'd2', token: 'mort' }],
        destroy: async ({ where }) => { detruits.push(...where.id); },
      },
    }));
    let messaging = null;
    jest.doMock('../../../config/firebase.js', () => ({ getMessaging: () => messaging }));
    const push = require('../../../infrastructure/push.service.js');
    expect(await push.envoyerAUtilisateur('u', { titre: 't', corps: 'c' })).toEqual({ envoye: false, raison: 'non_configure' });

    messaging = {
      sendEachForMulticast: jest.fn(async (message) => {
        expect(message.data).toEqual({ n: '5', vide: '' });
        return { successCount: 1, responses: [{ success: true }, { success: false, error: { code: 'messaging/registration-token-not-registered' } }] };
      }),
    };
    const r = await push.envoyerAUtilisateur('u', { titre: 't', corps: 'c', donnees: { n: 5, vide: null } });
    expect(r).toMatchObject({ envoye: true, reussis: 1 });
    expect(detruits).toEqual(['d2']);
    jest.dontMock('../../../models/index.js');
    jest.dontMock('../../../config/firebase.js');
  });
});

describe('e-mail transactionnel (Resend)', () => {
  test('sans clé : envoi ignoré, sans erreur ; le contenu est échappé', async () => {
    jest.resetModules();
    delete process.env.RESEND_API_KEY;
    const email = require('../../../infrastructure/email.service.js');
    expect(await email.envoyerCodeReinitialisation({ email: 'a@b.sn', prenom: '<b>x</b>', code: '123456', minutes: 15 })).toEqual({ envoye: false, raison: 'non_configure' });
  });
  test('avec clé : message construit, prénom échappé (pas d’injection HTML)', async () => {
    jest.resetModules();
    process.env.RESEND_API_KEY = 're_test';
    const envois = [];
    jest.doMock('resend', () => ({ Resend: class { constructor() { this.emails = { send: async (m) => { envois.push(m); return { data: { id: 'em_1' } }; } }; } } }));
    const email = require('../../../infrastructure/email.service.js');
    const r = await email.envoyerInvitationLocataire({ email: 'l@b.sn', prenom: '<script>', proprietaire: 'Balla', code: '12345678', lien: 'https://app/activation/x', jours: 7 });
    expect(r).toEqual({ envoye: true, id: 'em_1' });
    expect(envois[0].html).toContain('&lt;script&gt;');
    expect(envois[0].html).not.toContain('<script>');
    expect(envois[0].text).toContain('12345678');
    delete process.env.RESEND_API_KEY;
    jest.dontMock('resend');
  });
});

describe('disjoncteur des services externes', () => {
  const { Disjoncteur, avecDelai } = require('../../../utils/circuitBreaker.js');
  test('ouvert après N échecs, refus immédiat, puis essai unique et fermeture', async () => {
    const d = new Disjoncteur('test', { seuilEchecs: 2, dureeOuvertureMs: 50, delaiAppelMs: 1000 });
    const panne = () => Promise.reject(new Error('panne'));
    await expect(d.executer(panne)).rejects.toThrow('panne');
    await expect(d.executer(panne)).rejects.toThrow('panne');
    expect(d.etatCourant().etat).toBe('ouvert');
    await expect(d.executer(() => 'ok')).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_EXTERNE_INDISPONIBLE' });
    await new Promise((r) => setTimeout(r, 60));
    expect(await d.executer(() => 'ok')).toBe('ok');
    expect(d.etatCourant().etat).toBe('ferme');
  });
  test('un refus de la REQUÊTE ne compte pas comme une panne du service', async () => {
    const d = new Disjoncteur('test2', { seuilEchecs: 1, estEchecDependance: (e) => e.panne === true });
    await expect(d.executer(() => Promise.reject(Object.assign(new Error('adresse refusée'), { panne: false })))).rejects.toThrow();
    expect(d.etatCourant().etat).toBe('ferme');
  });
  test('délai dépassé → 503 réessayable', async () => {
    await expect(avecDelai(new Promise(() => {}), 20, 'lent')).rejects.toMatchObject({ statusCode: 503, code: 'DELAI_DEPASSE' });
    expect(await avecDelai(Promise.resolve(3), 20, 'rapide')).toBe(3);
  });
});

describe('stockage local (repli sans R2)', () => {
  const storage = require('../../../infrastructure/storage.service.js');
  test('enregistrer → ouvrir → lire → supprimer ; clé aléatoire sans information personnelle', async () => {
    const cle = await storage.enregistrer(Buffer.from('contenu'), 'owners/AbC/Travaux', 'pdf', 'application/pdf');
    expect(cle).toMatch(/^owners\/abc\/travaux\/\d{13}-[0-9a-f]{24}\.pdf$/);
    expect((await storage.lire(cle)).toString()).toBe('contenu');
    await storage.supprimer(cle);
    expect(await storage.ouvrir(cle)).toBeNull();
  });
  test.each(['../../etc/passwd', 'owners/../../secret.pdf', '/absolu/x.pdf', 'owners/x/1234-abc.pdf', '', null])(
    'clé invalide ou de traversée refusée : %p', async (cle) => {
      expect(await storage.ouvrir(cle)).toBeNull();
      await expect(storage.supprimer(cle)).resolves.toBeUndefined();
    }
  );
  test('URL signée : indisponible sans R2 ; sonde : « non configuré »', async () => {
    expect(await storage.urlTemporaire('owners/x/1234567890123-0123456789abcdef01234567.pdf')).toBeNull();
    expect(await storage.ping()).toEqual({ configure: false, joignable: null });
    expect(fs.existsSync(storage.UPLOAD_DIR)).toBe(true);
  });
});

describe('images (§ 37) et PDF', () => {
  test('métadonnées EXIF supprimées (localisation GPS), taille bornée, miniature WebP', async () => {
    const { preparerImage } = require('../../../infrastructure/image.service.js');
    const source = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#888' } })
      .jpeg().withMetadata({ exif: { IFD0: { Copyright: 'Téléphone du locataire' } } }).toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const { original, miniature } = await preparerImage(source, 'jpg');
    const mo = await sharp(original).metadata();
    expect(mo.exif).toBeUndefined();
    expect(Math.max(mo.width, mo.height)).toBe(2560);
    const mm = await sharp(miniature).metadata();
    expect(mm.format).toBe('webp');
    expect(Math.max(mm.width, mm.height)).toBe(480);
  });
  test('image corrompue refusée par le décodeur', async () => {
    const { preparerImage } = require('../../../infrastructure/image.service.js');
    await expect(preparerImage(Buffer.from([0xFF, 0xD8, 0xFF, 0x00, 1, 2, 3]), 'jpg')).rejects.toThrow();
  });
  test('générateur PDF : document valide, pages numérotées, texte inséré tel quel', async () => {
    const pdf = require('../../../infrastructure/pdf.service.js');
    const buffer = await pdf.generer((doc, a) => {
      a.titre('QUITTANCE');
      a.champs([['Locataire', 'Mamadou <script>'], ['Vide', null]]);
      a.tableau(['A', 'B'], Array.from({ length: 120 }, (_, i) => [`ligne ${i}`, 'x']), [1, 1]);
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect((buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length).toBeGreaterThan(1);
    await expect(pdf.generer(() => { throw new Error('dessin impossible'); })).rejects.toThrow('dessin impossible');
  });
});

describe('chiffrement des champs sensibles (§ 32)', () => {
  const { encrypt, decrypt } = require('../../../utils/cryptoField.js');
  test('aller-retour, IV aléatoire, valeurs vides et données en clair héritées', () => {
    const a = encrypt('CNI 1234');
    expect(a).toMatch(/^v1:/);
    expect(encrypt('CNI 1234')).not.toBe(a);
    expect(decrypt(a)).toBe('CNI 1234');
    expect(encrypt('')).toBe('');
    expect(encrypt(null)).toBeNull();
    expect(decrypt('ancienne valeur en clair')).toBe('ancienne valeur en clair');
  });
  test('valeur altérée : déchiffrement refusé (authentification GCM)', () => {
    const [v, iv, tag, donnees] = encrypt('secret').split(':');
    const altere = [v, iv, tag, Buffer.from('autre-contenu').toString('base64')].join(':');
    expect(() => decrypt(altere)).toThrow('Impossible de déchiffrer');
    expect(donnees).toBeTruthy();
  });
});

describe('cache applicatif (repli mémoire sans Redis)', () => {
  const cache = require('../../../utils/cache.js');
  test('lecture, expiration, invalidation par motif, calcul unique concurrent', async () => {
    await cache.ecrire('t:a:1', { v: 1 }, 1);
    await cache.ecrire('t:b:1', { v: 2 }, 60);
    expect(await cache.lire('t:a:1')).toEqual({ v: 1 });
    await cache.invalider('t:b:*');
    expect(await cache.lire('t:b:1')).toBeNull();
    await new Promise((r) => setTimeout(r, 1100));
    expect(await cache.lire('t:a:1')).toBeNull();
    let calculs = 0;
    const calcul = async () => { calculs += 1; await new Promise((r) => setTimeout(r, 30)); return 42; };
    expect(await Promise.all([cache.volUnique('k', calcul), cache.volUnique('k', calcul)])).toEqual([42, 42]);
    expect(calculs).toBe(1);
  });
});

describe('métriques', () => {
  const metrics = require('../../../utils/metrics.js');
  test('instantané JSON et format Prometheus', () => {
    metrics.incrementer('test.compteur', 2);
    metrics.enregistrerErreur('CODE_TEST');
    const inst = metrics.instantane();
    expect(inst).toEqual(expect.objectContaining({}));
    const texte = metrics.formatPrometheus();
    expect(typeof texte).toBe('string');
    expect(texte).toMatch(/# (HELP|TYPE)/);
  });
});
