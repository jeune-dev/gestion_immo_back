'use strict';

/**
 * Le code d'accès à quatre chiffres des super admins : vérifié par le
 * serveur, exigé par /admin, bloqué après cinq échecs, fixe pour
 * kodafrik_admin@gmail.com (0000).
 */

const bcrypt = require('bcryptjs');

const mockQuery = jest.fn();
const mockMaj = jest.fn();
const mockTrouver = jest.fn();

jest.mock('../../../config/db.js', () => ({ query: (...a) => mockQuery(...a) }));
jest.mock('../../../models/index.js', () => ({
  User: { findByPk: (...a) => mockTrouver(...a) },
  RefreshToken: { update: (...a) => mockMaj(...a) },
}));
jest.mock('../../../utils/motDePasse.js', () => require('bcryptjs'));
jest.mock('../../../modules/auth/service/session.service.js', () => ({
  genererAccessToken: (u, r, o = {}) => `jeton:${u.id}:${o.codeAcces ? 'ca' : '-'}:${o.sid || ''}`,
}));

const CodeAcces = require('../../../modules/auth/service/codeAcces.service.js');
const { exigerCodeAcces } = require('../../../middlewares/acces.middleware.js');

const HASH_1234 = bcrypt.hashSync('1234', 4);
const ADMIN = { id: 'a1', role_code: 'super_admin', email: 'fatou@kodafrik.com' };
const FIXE = { id: 'k1', role_code: 'super_admin', email: 'kodafrik_admin@gmail.com' };
const SID = 'ab'.repeat(16);
const T0 = Date.UTC(2026, 10, 26, 12);

function base(...reponses) {
  mockQuery.mockReset();
  for (const r of reponses) mockQuery.mockResolvedValueOnce(r);
  mockQuery.mockResolvedValue([]);
}

beforeEach(() => { mockMaj.mockReset(); mockTrouver.mockReset(); delete process.env.CODE_ACCES_ADMIN_OBLIGATOIRE; });

describe('verifier', () => {
  test('bon code : la session est marquée et le jeton rendu ouvre /admin', async () => {
    base([{ code_hash: HASH_1234, echecs: 0, bloque_jusqua: null }]);
    const r = await CodeAcces.verifier(ADMIN, '1234', { sessionId: SID, maintenant: T0 });
    expect(r).toEqual({ valide: true, access_token: `jeton:a1:ca:${SID}` });
    expect(mockMaj).toHaveBeenCalledWith(
      { code_acces_verifie_le: new Date(T0) },
      { where: expect.objectContaining({ user_id: 'a1', revoked_at: null }) },
    );
  });

  test('mauvais code : 401 et échec compté ; au cinquième, bloqué 15 min (423)', async () => {
    base([{ code_hash: HASH_1234, echecs: 0, bloque_jusqua: null }]);
    await expect(CodeAcces.verifier(ADMIN, '9999', { maintenant: T0 })).rejects.toMatchObject({ statusCode: 401, code: 'CODE_ACCES_INCORRECT' });
    expect(mockQuery.mock.calls[1][1].replacements).toMatchObject({ echecs: 1, jusqua: null });

    base([{ code_hash: HASH_1234, echecs: 4, bloque_jusqua: null }]);
    await expect(CodeAcces.verifier(ADMIN, '9999', { maintenant: T0 })).rejects.toMatchObject({ statusCode: 423, code: 'CODE_ACCES_BLOQUE' });
    expect(mockQuery.mock.calls[1][1].replacements.jusqua).toEqual(new Date(T0 + 15 * 60000));

    base([{ code_hash: HASH_1234, echecs: 0, bloque_jusqua: new Date(T0 + 60000) }]);
    await expect(CodeAcces.verifier(ADMIN, '1234', { maintenant: T0 })).rejects.toMatchObject({ statusCode: 423 });
  });

  test('aucun code défini : 403, le mot de passe seul ne suffit jamais', async () => {
    base([]);
    await expect(CodeAcces.verifier(ADMIN, '1234')).rejects.toMatchObject({ statusCode: 403, code: 'CODE_ACCES_NON_DEFINI' });
  });

  test('kodafrik_admin@gmail.com : 0000 seul, même sans ligne ou avec un autre code en base', async () => {
    base([]);
    await expect(CodeAcces.verifier(FIXE, '0000', { maintenant: T0 })).resolves.toMatchObject({ valide: true });
    base([{ code_hash: HASH_1234, echecs: 0, bloque_jusqua: null }]);
    await expect(CodeAcces.verifier(FIXE, '1234', { maintenant: T0 })).rejects.toMatchObject({ statusCode: 401 });
  });

  test('compte non super admin, code mal formé : refusés', async () => {
    await expect(CodeAcces.verifier({ id: 'p', role_code: 'proprietaire' }, '1234')).rejects.toMatchObject({ statusCode: 403 });
    await expect(CodeAcces.verifier(ADMIN, '12')).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('definir', () => {
  test('enregistre le code haché et retire le drapeau des sessions vérifiées', async () => {
    mockTrouver.mockResolvedValue(ADMIN);
    base();
    await CodeAcces.definir('a1', '0427', { auteurId: 's1' });
    const { hash } = mockQuery.mock.calls[0][1].replacements;
    expect(bcrypt.compareSync('0427', hash)).toBe(true);
    expect(mockMaj).toHaveBeenCalledWith({ code_acces_verifie_le: null }, expect.objectContaining({ where: expect.objectContaining({ user_id: 'a1' }) }));
  });

  test('le code fixe de kodafrik_admin@gmail.com ne se change pas (409)', async () => {
    mockTrouver.mockResolvedValue(FIXE);
    await expect(CodeAcces.definir('k1', '1111')).rejects.toMatchObject({ statusCode: 409, code: 'CODE_ACCES_FIXE' });
  });
});

describe('exigerCodeAcces', () => {
  const passer = (req) => { const next = jest.fn(); exigerCodeAcces(req, {}, next); return next.mock.calls[0][0]; };

  test('code vérifié : passe', () => {
    expect(passer({ user: ADMIN, codeAccesVerifie: true })).toBeUndefined();
  });
  test('mot de passe seul : 403 CODE_ACCES_REQUIS', () => {
    expect(passer({ user: ADMIN, codeAccesVerifie: false })).toMatchObject({ statusCode: 403, code: 'CODE_ACCES_REQUIS' });
  });
  test('dépannage (CODE_ACCES_ADMIN_OBLIGATOIRE=false) : passe', () => {
    process.env.CODE_ACCES_ADMIN_OBLIGATOIRE = 'false';
    expect(passer({ user: ADMIN })).toBeUndefined();
  });
});
