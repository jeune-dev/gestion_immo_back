'use strict';

const dates = require('../../../utils/dates.js');
const { repartirProportionnellement, entier, formatFcfa } = require('../../../utils/montants.js');
const { normaliserTelephone, masquerTelephone } = require('../../../utils/telephone.js');
const escapeLike = require('../../../utils/escapeLike.js');
const escapeHtml = require('../../../utils/escapeHtml.js');
const masquerUrl = require('../../../utils/masquerUrl.js');
const hashToken = require('../../../utils/hashToken.js');
const { ordre, rechercheTexte, periode } = require('../../../utils/liste.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const { Op } = require('sequelize');

afterAll(() => require('../../../config/db.js').close());

describe('dates', () => {
  test('aujourdhui dans le fuseau de Dakar (UTC+0, sans heure d’été)', () => {
    expect(dates.aujourdhui(new Date('2026-12-31T23:30:00Z'))).toBe('2026-12-31');
    expect(dates.aujourdhui(new Date('2027-01-01T00:10:00Z'))).toBe('2027-01-01');
  });
  test('ajouterMois borne le jour ; années bissextiles', () => {
    expect(dates.ajouterMois('2026-01-31', 1)).toBe('2026-02-28');
    expect(dates.ajouterMois('2028-01-31', 1)).toBe('2028-02-29');
    expect(dates.ajouterMois('2026-11-30', 3)).toBe('2027-02-28');
    expect(dates.ajouterMois('2026-03-15', -2)).toBe('2026-01-15');
  });
  test('ajouterJours, ecartJours, debutMois, finMois', () => {
    expect(dates.ajouterJours('2026-12-31', 1)).toBe('2027-01-01');
    expect(dates.ajouterJours('2026-03-01', -1)).toBe('2026-02-28');
    expect(dates.ecartJours('2026-09-05', '2026-09-01')).toBe(-4);
    expect(dates.debutMois('2026-09-23')).toBe('2026-09-01');
    expect(dates.finMois('2026-02-10')).toBe('2026-02-28');
  });
  test('libellés et formats', () => {
    expect(dates.libelleMois('2026-10-01')).toBe('octobre 2026');
    expect(dates.formatFr('2026-09-23')).toBe('23/09/2026');
    expect(dates.formatFr(null)).toBe('');
    expect(dates.formatFr(new Date('2026-09-23T10:00:00Z'))).toBe('23/09/2026');
    expect(dates.compacte('2026-09-23')).toBe('20260923');
  });
});

describe('montants', () => {
  test('répartition exacte et déterministe, quel que soit le reste', () => {
    for (let total = 0; total < 200; total += 7) {
      const parts = repartirProportionnellement(total, [1, 2, 3, 0.5]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every(Number.isInteger)).toBe(true);
    }
    expect(repartirProportionnellement(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(repartirProportionnellement(0, [1, 1])).toEqual([0, 0]);
    expect(repartirProportionnellement(5, [0, 1])).toEqual([0, 5]);
  });
  test.each([[-1, [1]], [1.5, [1]], [10, []], [10, [-1, 2]], [10, [0, 0]], [10, [NaN]], [10, 'x']])(
    'entrées invalides refusées (%p, %p)', (total, poids) => expect(() => repartirProportionnellement(total, poids)).toThrow(RangeError)
  );
  test('entier et format FCFA', () => {
    expect(entier('12.6')).toBe(13);
    expect(() => entier('abc')).toThrow();
    expect(() => entier(Infinity)).toThrow();
    expect(formatFcfa(1234567)).toBe('1 234 567 FCFA');
    expect(formatFcfa(-50000)).toBe('-50 000 FCFA');
    expect(formatFcfa(null)).toBe('0 FCFA');
  });
});

describe('téléphone', () => {
  test('masquage pour journaux', () => {
    expect(masquerTelephone('+221771234567')).toBe('+22177•••••67');
    expect(masquerTelephone('123')).toBe('•••');
    expect(masquerTelephone(null)).toBeNull();
  });
  test.each(['', '   ', 'abc', '12', '+1234567890123456789', undefined, null])('inexploitable : %p', (v) => expect(normaliserTelephone(v)).toBeNull());
  test('le zéro de tête d’un numéro national est ignoré', () => expect(normaliserTelephone('077 123 45 67')).toBe('+221771234567'));
});

describe('échappements et masquages', () => {
  test('LIKE : jokers et antislash neutralisés', () => {
    expect(escapeLike('100%_\\')).toBe('100\\%\\_\\\\');
    expect(escapeLike(null)).toBe('');
  });
  test('HTML : tous les caractères actifs échappés', () => {
    expect(escapeHtml('<img src=x onerror="a(\'b\')">&')).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
    expect(escapeHtml(undefined)).toBe('');
  });
  test('URL : jetons et liens d’activation masqués, route conservée', () => {
    expect(masquerUrl('/api/v1/x?token=abc&page=2&code=123456')).toBe('/api/v1/x?token=[masqué]&page=2&code=[masqué]');
    expect(masquerUrl('/activation/secretXYZ?x=1')).toBe('/activation/[masqué]?x=1');
    expect(masquerUrl('/webhooks/whatsapp?hub.verify_token=s3cr3t&hub.challenge=9')).toBe('/webhooks/whatsapp?hub.verify_token=[masqué]&hub.challenge=9');
    expect(masquerUrl(undefined)).toBe('');
  });
  test('empreinte des jetons : SHA-256 déterministe de 64 caractères', () => {
    expect(hashToken('a')).toBe(hashToken('a'));
    expect(hashToken('a')).not.toBe(hashToken('b'));
    expect(hashToken('a')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('construction des listes', () => {
  test('ordre : sens, correspondance de colonne, départage stable par id', () => {
    expect(ordre('-created_at', 'name')).toEqual([['created_at', 'DESC'], ['id', 'ASC']]);
    expect(ordre(undefined, 'name')).toEqual([['name', 'ASC'], ['id', 'ASC']]);
    expect(ordre('nom', 'x', { nom: ['tenant', 'last_name'] })).toEqual([['tenant', 'last_name', 'ASC'], ['id', 'ASC']]);
  });
  test('recherche : terme échappé sur toutes les colonnes, rien si vide', () => {
    expect(rechercheTexte('', ['a'])).toBeNull();
    const r = rechercheTexte('50%', ['a', 'b']);
    expect(r[Op.or]).toEqual([{ a: { [Op.iLike]: '%50\\%%' } }, { b: { [Op.iLike]: '%50\\%%' } }]);
  });
  test('période : bornes facultatives', () => {
    expect(periode()).toBeNull();
    expect(periode('2026-01-01')).toEqual({ [Op.gte]: '2026-01-01' });
    expect(periode(null, '2026-12-31')).toEqual({ [Op.lte]: '2026-12-31' });
  });
});

describe('enveloppe des réponses', () => {
  const faux = () => {
    const res = { statut: null, corps: null };
    res.status = (s) => { res.statut = s; return res; };
    res.json = (c) => { res.corps = c; return res; };
    return res;
  };
  test('ok, created, paginated', () => {
    expect(ok(faux(), { a: 1 }).corps).toEqual({ success: true, message: 'Succès', data: { a: 1 } });
    expect(created(faux(), {}).statut).toBe(201);
    const p = paginated(faux(), { rows: [1, 2], count: 45 }, { page: 2, limit: 20 });
    expect(p.corps.data.pagination).toEqual({ page: 2, limit: 20, total: 45, totalPages: 3 });
    expect(paginated(faux(), { rows: [], count: 0 }, { page: 1, limit: 20 }).corps.data.pagination.totalPages).toBe(1);
  });
});
