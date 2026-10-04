'use strict';

const { User, Tenant, PaymentProvider } = require('../../../models/index.js');
const { COLONNES_SECRETES } = require('../../../models/user.model.js');
const { encrypt, decrypt } = require('../../../utils/cryptoField.js');

/**
 * § 32 « chiffrement des données sensibles » et non-divulgation des secrets :
 * vérifié sur des instances construites en mémoire (aucune base).
 */

describe('User.toJSON', () => {
  test('ne sérialise jamais empreinte, version de jeton, compteur, verrouillage, suppression', () => {
    const user = User.build({
      role_code: 'proprietaire', first_name: 'A', last_name: 'B', email: 'a@b.sn', password_hash: '$2b$12$secret',
      token_version: 7, failed_login_attempts: 3, locked_until: new Date(), deleted_at: new Date(),
    });
    const json = user.toJSON();
    for (const cle of ['password_hash', 'token_version', 'failed_login_attempts', 'locked_until', 'deleted_at']) expect(json).not.toHaveProperty(cle);
    expect(json).toMatchObject({ first_name: 'A', email: 'a@b.sn', role_code: 'proprietaire' });
    expect(JSON.stringify(user)).not.toContain('$2b$12$secret');
    // La valeur reste lisible côté serveur (comparaison bcrypt).
    expect(user.password_hash).toBe('$2b$12$secret');
  });

  test('liste des colonnes secrètes exportée et complète', () => {
    expect(COLONNES_SECRETES).toEqual(expect.arrayContaining(['password_hash', 'token_version', 'failed_login_attempts', 'locked_until']));
  });
});

describe('Tenant.id_document_number', () => {
  test('chiffré au repos (AES-256-GCM, v1:), déchiffré par le getter', () => {
    const t = Tenant.build({ owner_id: '3f1c2b9e-1d2a-4c3b-9a8b-7c6d5e4f3a2b', first_name: 'F', last_name: 'S', phone: '+221771234567', id_document_number: '1234567890123' });
    const brut = t.getDataValue('id_document_number');
    expect(brut).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(brut).not.toContain('1234567890123');
    expect(t.id_document_number).toBe('1234567890123');
  });

  test('IV aléatoire : deux chiffrements de la même valeur diffèrent', () => {
    const a = Tenant.build({ id_document_number: 'A1' }).getDataValue('id_document_number');
    const b = Tenant.build({ id_document_number: 'A1' }).getDataValue('id_document_number');
    expect(a).not.toBe(b);
  });

  test('valeur vide ou nulle : stockée null', () => {
    expect(Tenant.build({ id_document_number: '' }).getDataValue('id_document_number')).toBeNull();
    expect(Tenant.build({ id_document_number: null }).getDataValue('id_document_number')).toBeNull();
  });

  test('donnée altérée : déchiffrement refusé (tag GCM)', () => {
    const chiffre = encrypt('secret');
    const [v, iv, tag, donnees] = chiffre.split(':');
    const altere = `${v}:${iv}:${tag}:${Buffer.from('autre-chose').toString('base64')}`;
    expect(() => decrypt(altere)).toThrow(/déchiffrer/);
    expect(decrypt(`${v}:${iv}:${tag}:${donnees}`)).toBe('secret');
  });
});

describe('PaymentProvider.credentials', () => {
  test('objet chiffré au repos, relu par le getter, JAMAIS dans toJSON', () => {
    const fournisseur = PaymentProvider.build({
      owner_id: '3f1c2b9e-1d2a-4c3b-9a8b-7c6d5e4f3a2b', provider: 'paydunya', mode: 'test', credentials: { master_key: 'CLE_API_SECRETE', private_key: 'SECRET_2' },
    });
    const brut = fournisseur.getDataValue('credentials');
    expect(brut).toMatch(/^v1:/);
    expect(brut).not.toContain('CLE_API_SECRETE');
    expect(fournisseur.credentials).toEqual({ master_key: 'CLE_API_SECRETE', private_key: 'SECRET_2' });
    const json = fournisseur.toJSON();
    expect(json).not.toHaveProperty('credentials');
    expect(json.credentials_configured).toBe(true);
    expect(JSON.stringify(fournisseur)).not.toMatch(/CLE_API_SECRETE|SECRET_2/);
  });

  test('sans identifiants : credentials_configured = false', () => {
    const fournisseur = PaymentProvider.build({ provider: 'wave', mode: 'test' });
    expect(fournisseur.toJSON()).toMatchObject({ credentials_configured: false });
    expect(fournisseur.credentials).toBeNull();
  });
});
