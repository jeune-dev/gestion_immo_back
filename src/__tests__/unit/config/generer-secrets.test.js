'use strict';

const { genererSecrets } = require('../../../../scripts/generer-secrets.js');
const { validerMotDePasseAdmin } = require('../../../config/validationMotDePasse.js');

/** CORRECTIF M1 — générateur de secrets de production (npm run secrets:generer). */
describe('Générateur de secrets', () => {
  test('jeu complet, bien formé, tous les secrets distincts', () => {
    const s = genererSecrets();
    expect(Object.keys(s).sort()).toEqual(['ADMIN_PASSWORD', 'APP_ENC_KEY', 'DB_ADMIN_PASSWORD', 'DB_PASSWORD', 'INVITATION_SECRET', 'JWT_REFRESH_SECRET', 'JWT_SECRET', 'METRICS_TOKEN', 'REDIS_PASSWORD']);
    expect(Buffer.from(s.APP_ENC_KEY, 'base64')).toHaveLength(32);
    for (const cle of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'INVITATION_SECRET']) expect(s[cle].length).toBeGreaterThanOrEqual(32);
    expect(s.REDIS_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(validerMotDePasseAdmin(s.ADMIN_PASSWORD, 'admin@exemple.sn')).toBeNull();
    expect(new Set(Object.values(s)).size).toBe(Object.keys(s).length);
  });

  test('deux générations ne partagent aucune valeur', () => {
    const a = Object.values(genererSecrets());
    const b = new Set(Object.values(genererSecrets()));
    expect(a.some((v) => b.has(v))).toBe(false);
  });
});
