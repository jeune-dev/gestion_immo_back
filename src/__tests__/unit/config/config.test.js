'use strict';

const E = require('../../../config/enums.js');
const { schemaParametresProprietaire, parametresProprietaire, SCHEMAS_PLATEFORME, DEFAUTS_PLATEFORME } = require('../../../config/parametres.js');

/**
 * Configuration : garde-fous de démarrage en production (§ 11 « secrets jamais
 * codés en dur », § 32) et paramètres configurables du cahier des charges.
 */

/**
 * Charge config/security.js avec un environnement donné (isolé). Une variable
 * « absente » est posée VIDE : dotenv ne réécrit jamais une variable existante,
 * alors qu'il recopierait celle du fichier .env local si on la supprimait.
 */
function chargerSecurite(env) {
  const sauvegarde = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try {
    let module;
    jest.isolateModules(() => { module = require('../../../config/security.js'); });
    return module;
  } finally {
    process.env = sauvegarde;
  }
}

const SECRET_A = 'a'.repeat(40);
const SECRET_B = 'b'.repeat(40);
const SECRET_C = 'c'.repeat(40);
const PROD = {
  NODE_ENV: 'production', JWT_SECRET: SECRET_A, JWT_REFRESH_SECRET: SECRET_B, INVITATION_SECRET: SECRET_C,
  APP_ENC_KEY: Buffer.alloc(32, 1).toString('base64'), CORS_ORIGIN: 'https://admin.exemple.sn',
  REDIS_URL: 'redis://:motdepasse@redis:6379', METRICS_TOKEN: 'm'.repeat(40), ALERT_WEBHOOK_URL: 'https://alertes.exemple.sn/hook',
  PAYDUNYA_BASE_URL: '', PAYDUNYA_MASTER_KEY: '',
};

describe('garde-fous de démarrage (config/security.js)', () => {
  test('production correctement configurée : démarre', () => {
    const s = chargerSecurite(PROD);
    expect(s.isProd).toBe(true);
    expect(s.corsConfig.origin).toEqual(['https://admin.exemple.sn']);
    expect(s.cookieRefresh).toMatchObject({ httpOnly: true, secure: true, sameSite: 'strict' });
    expect(s.jwtConfig.expiresIn).toBe('15m');
  });
  test.each([
    ['secret JWT absent', { JWT_SECRET: '' }, /manquantes/],
    ['secrets identiques', { JWT_REFRESH_SECRET: SECRET_A }, /différents/],
    ['secret trop court en production', { JWT_SECRET: 'court' }, /32 caractères/],
    ['CORS ouvert à tous en production', { CORS_ORIGIN: 'https://a.sn,*' }, /CORS_ORIGIN=\*/],
    ['clé de chiffrement absente en production', { APP_ENC_KEY: '' }, /APP_ENC_KEY/],
    // CORRECTIF M1 : secrets bien formés et tous distincts, vérifiés au démarrage.
    ['clé de chiffrement de 16 octets au lieu de 32', { APP_ENC_KEY: Buffer.alloc(16, 1).toString('base64') }, /32 octets/],
    ['secret d’invitation absent', { INVITATION_SECRET: '' }, /INVITATION_SECRET/],
    ['secret d’invitation trop court', { INVITATION_SECRET: 'court' }, /INVITATION_SECRET/],
    ['secret d’invitation = secret JWT', { INVITATION_SECRET: SECRET_A }, /différents/],
    ['jeton de métriques = secret de rafraîchissement', { METRICS_TOKEN: SECRET_B }, /différents/],
    ['CORS_ORIGIN absent en production', { CORS_ORIGIN: '' }, /CORS_ORIGIN est obligatoire/],
    ['origine CORS en http:// en production', { CORS_ORIGIN: 'http://admin.exemple.sn' }, /https/],
    // CORRECTIF M9 : supervision obligatoire en production.
    ['Redis absent (limites par processus, contournables)', { REDIS_URL: '' }, /REDIS_URL/],
    ['jeton de métriques absent', { METRICS_TOKEN: '' }, /METRICS_TOKEN/],
    ['jeton de métriques trop court', { METRICS_TOKEN: 'court' }, /METRICS_TOKEN/],
    ['aucun canal d’alerte', { ALERT_WEBHOOK_URL: '', ALERT_EMAIL: '' }, /canal d’alerte/],
    // CORRECTIF M11 : pas de bac à sable PayDunya ni de redirection des paiements en production.
    ['URL PayDunya redirigée en production', { PAYDUNYA_BASE_URL: 'https://intermediaire.exemple' }, /PAYDUNYA_BASE_URL/],
    ['clés PayDunya de la plateforme en mode test', { PAYDUNYA_MASTER_KEY: 'k', PAYDUNYA_MODE: 'test' }, /PAYDUNYA_MODE/],
  ])('refus : %s', (_, surcharge, message) => {
    expect(() => chargerSecurite({ ...PROD, ...surcharge })).toThrow(message);
  });
  test('un seul canal d’alerte suffit (e-mail sans webhook)', () => {
    expect(() => chargerSecurite({ ...PROD, ALERT_WEBHOOK_URL: '', ALERT_EMAIL: 'astreinte@exemple.sn' })).not.toThrow();
  });

  test('PayDunya plateforme en mode live : démarre ; dérogation de préproduction explicite : démarre', () => {
    expect(() => chargerSecurite({ ...PROD, PAYDUNYA_MASTER_KEY: 'k', PAYDUNYA_MODE: 'live' })).not.toThrow();
    expect(() => chargerSecurite({ ...PROD, PAYDUNYA_MASTER_KEY: 'k', PAYDUNYA_MODE: 'test', PAIEMENT_MODE_TEST_AUTORISE: '1' })).not.toThrow();
  });

  test('politique du mot de passe super admin', () => {
    const { validerMotDePasseAdmin: v } = chargerSecurite(PROD);
    expect(v('Kx7!mQ2#vLp9Tz', 'boss@exemple.sn')).toBeNull();
    expect(v('', 'x')).toMatch(/requis/);
    expect(v('Ab1!court', 'x')).toMatch(/12 caractères/);
    expect(v('toutenminuscule1!', 'x')).toMatch(/majuscule/);
    expect(v('Password1234!!', 'x')).toMatch(/prévisible/);
    expect(v('Kx7!bossierXYZ', 'bossier@exemple.sn')).toMatch(/adresse e-mail/);
  });
});

describe('paramètres configurables (§ 14, 52, 54.3, 55)', () => {
  test('défauts du cahier des charges : relances J-3, J0, J+3, J+7, J+15', () => {
    expect(parametresProprietaire(null).reminder_offsets).toEqual([-3, 0, 3, 7, 15]);
    expect(parametresProprietaire({ settings: { late_grace_days: 2 } })).toMatchObject({ late_grace_days: 2, entry_inspection_policy: 'bloquant' });
  });
  test.each([
    [{ reminder_offsets: [] }], [{ reminder_offsets: [1, 1] }], [{ reminder_offsets: [500] }],
    [{ entry_inspection_policy: 'jamais' }], [{ inspection_response_days: 0 }], [{ channel_order: ['pigeon'] }],
    [{ notification_strategy: 'aleatoire' }], [{ deposit_refund_days: 365 }],
  ])('valeur refusée : %o', (valeur) => {
    expect(schemaParametresProprietaire.validate(valeur).error).toBeDefined();
  });
  test('paramètres plateforme : défauts valides selon leur propre schéma', () => {
    for (const [cle, schema] of Object.entries(SCHEMAS_PLATEFORME)) {
      expect(schema.validate(DEFAUTS_PLATEFORME[cle]).error).toBeUndefined();
    }
    expect(SCHEMAS_PLATEFORME.otp.validate({ duree_minutes: 1, tentatives_max: 5 }).error).toBeDefined();
  });
});

describe('énumérations', () => {
  test('chaque code a un libellé non vide et les codes sont uniques', () => {
    for (const [nom, valeur] of Object.entries(E)) {
      if (typeof valeur !== 'object' || nom === 'MOIS_PAR_PERIODICITE' || nom === 'GRAVITE_ETAT') continue;
      const codes = Object.keys(valeur);
      expect(new Set(codes).size).toBe(codes.length);
      for (const libelle of Object.values(valeur)) expect(String(libelle).trim()).not.toBe('');
    }
  });
  test('périodicités et gravités couvrent exactement leurs énumérations', () => {
    expect(Object.keys(E.MOIS_PAR_PERIODICITE).sort()).toEqual(E.codes(E.PERIODICITE).sort());
    expect(Object.keys(E.GRAVITE_ETAT).sort()).toEqual(E.codes(E.ETAT_ELEMENT).sort());
  });
});
