'use strict';

const express = require('express');
const request = require('supertest');
const Joi = require('joi');
const errorHandler = require('../../../middlewares/errorHandler.middleware.js');
const { normaliser, estBaseIndisponible } = errorHandler;
const paginate = require('../../../middlewares/pagination.middleware.js');
const validate = require('../../../middlewares/validate.middleware.js');
const requestId = require('../../../middlewares/requestId.middleware.js');
const { detecterType, recevoirFichier } = require('../../../middlewares/upload.middleware.js');
const { requireRole, requirePermission, requireProprietaire } = require('../../../middlewares/acces.middleware.js');
const E = require('../../../errors/AppError.js');

afterAll(() => require('../../../config/db.js').close());

/** Mini-application : un middleware, puis l'état de la requête en JSON. */
function appAvec(...middlewares) {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.all('/t', ...middlewares, (req, res) => res.json({ pagination: req.pagination, query: req.query, body: req.body, fichier: req.fichier && { type: req.fichier.type, taille: req.fichier.taille } }));
  app.use(errorHandler);
  return app;
}

describe('gestionnaire d’erreurs — normalisation', () => {
  test.each([
    [new E.BadRequestError('x'), 400, 'REQUETE_INVALIDE'],
    [new E.UnauthorizedError(), 401, 'NON_AUTHENTIFIE'],
    [new E.PaymentRequiredError(), 402, 'ABONNEMENT_REQUIS'],
    [new E.ForbiddenError('x', 'CODE_METIER'), 403, 'CODE_METIER'],
    [new E.NotFoundError(), 404, 'RESSOURCE_INTROUVABLE'],
    [new E.ConflictError(), 409, 'CONFLIT'],
    [new E.ValidationError('x', ['a']), 422, 'DONNEES_INVALIDES'],
    [new E.ServiceIndisponibleError(), 503, 'SERVICE_INDISPONIBLE'],
    [Object.assign(new Error('jwt'), { name: 'TokenExpiredError' }), 401, 'TOKEN_EXPIRE'],
    [Object.assign(new Error('jwt'), { name: 'JsonWebTokenError' }), 401, 'TOKEN_INVALIDE'],
    [Object.assign(new Error('m'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' }), 413, 'FICHIER_TROP_VOLUMINEUX'],
    [Object.assign(new Error('m'), { name: 'MulterError', code: 'LIMIT_UNEXPECTED_FILE' }), 400, 'ENVOI_FICHIER_INVALIDE'],
    [Object.assign(new Error('p'), { type: 'entity.parse.failed' }), 400, 'JSON_INVALIDE'],
    [Object.assign(new Error('p'), { type: 'entity.too.large', status: 413 }), 413, 'CONTENU_TROP_VOLUMINEUX'],
    [Object.assign(new Error('v'), { name: 'SequelizeValidationError', errors: [{ message: 'm' }] }), 422, 'DONNEES_INVALIDES'],
    [Object.assign(new Error('u'), { name: 'SequelizeUniqueConstraintError' }), 409, 'RESSOURCE_EXISTANTE'],
    [Object.assign(new Error('f'), { name: 'SequelizeForeignKeyConstraintError' }), 400, 'REFERENCE_INVALIDE'],
    [Object.assign(new Error('c'), { name: 'SequelizeDatabaseError', parent: { code: '23514' } }), 422, 'DONNEES_INCOHERENTES'],
    [Object.assign(new Error('u'), { name: 'SequelizeDatabaseError', parent: { code: '22P02' } }), 404, 'RESSOURCE_INTROUVABLE'],
    [Object.assign(new Error('t'), { name: 'SequelizeDatabaseError', parent: { code: '57014' } }), 503, 'BASE_INDISPONIBLE'],
    [Object.assign(new Error('d'), { name: 'SequelizeDatabaseError', parent: { code: '40P01' } }), 503, 'BASE_INDISPONIBLE'],
    [Object.assign(new Error('a'), { name: 'SequelizeConnectionAcquireTimeoutError' }), 503, 'BASE_INDISPONIBLE'],
    [new Error('bug imprévu'), 500, 'ERREUR_INTERNE'],
  ])('%s → %i %s', (err, statut, code) => {
    const n = normaliser(err);
    expect(n.statut).toBe(statut);
    expect(n.code).toBe(code);
  });

  test('503 : délai de reprise ; 500 en production : message générique, jamais le détail', () => {
    expect(normaliser(new E.ServiceIndisponibleError('x', 'X', { reessayerDansS: 9 })).retryAfterS).toBe(9);
    expect(estBaseIndisponible({ parent: { code: '08006' } })).toBe(true);
    expect(estBaseIndisponible({ parent: { code: '23505' } })).toBe(false);
    jest.isolateModules(() => {
      const avant = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const prod = require('../../../middlewares/errorHandler.middleware.js');
      expect(prod.normaliser(new Error('SELECT * FROM secret')).message).toBe('Erreur interne du serveur');
      process.env.NODE_ENV = avant;
    });
  });

  test('réponse HTTP : enveloppe uniforme, identifiant de requête, en-tête Retry-After', async () => {
    const app = express();
    app.use(requestId);
    app.get('/x', () => { throw new E.ServiceIndisponibleError('Indispo', 'X', { reessayerDansS: 7 }); });
    app.use(errorHandler);
    const res = await request(app).get('/x').set('X-Request-Id', 'identifiant-client-1234');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('7');
    expect(res.headers['x-request-id']).toBe('identifiant-client-1234');
    expect(res.body).toMatchObject({ success: false, message: 'Indispo', code: 'X', error: { code: 'X' }, requestId: 'identifiant-client-1234' });
  });
});

describe('identifiant de requête', () => {
  test('repris s’il est valide, généré sinon (pas d’injection dans les journaux)', async () => {
    const app = appAvec();
    expect((await request(app).get('/t').set('X-Request-Id', 'abc')).headers['x-request-id']).not.toBe('abc');
    expect((await request(app).get('/t').set('X-Request-Id', 'ok-1234567')).headers['x-request-id']).toBe('ok-1234567');
    expect(requestId.identifiantEntrant('a\nb-injection')).toBeNull();
    expect(requestId.identifiantEntrant(['valide-123456'])).toBe('valide-123456');
  });
});

describe('pagination', () => {
  const app = appAvec(paginate({ max: 50, defaut: 10 }));
  test.each([
    ['', { page: 1, limit: 10, offset: 0 }],
    ['?page=3&limit=5', { page: 3, limit: 5, offset: 10 }],
    ['?limit=1000', { page: 1, limit: 50, offset: 0 }],
    ['?page=999999', { page: 5000, limit: 10, offset: 49990 }],
    ['?page=2&page=4', { page: 4, limit: 10, offset: 30 }],
  ])('%s → %o', async (qs, attendu) => {
    expect((await request(app).get(`/t${qs}`)).body.pagination).toEqual(attendu);
  });
  test.each(['?page=0', '?page=-2', '?page=abc', '?limit=0', '?limit=2.5', '?limit=1e2', '?page='])('%s → 422', async (qs) => {
    const res = await request(app).get(`/t${qs}`);
    if (qs === '?page=') expect(res.status).toBe(200);
    else {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('PAGINATION_INVALIDE');
    }
  });
});

describe('validation Joi', () => {
  const schema = Joi.object({ nombre: Joi.number().integer().required(), texte: Joi.string().max(3) });
  test('corps : valeurs converties, champs inconnus retirés (affectation de masse impossible)', async () => {
    const app = appAvec(validate(schema));
    const res = await request(app).post('/t').send({ nombre: '12', owner_id: 'pirate', status: 'paye' });
    expect(res.body.body).toEqual({ nombre: 12 });
  });
  test('toutes les erreurs sont renvoyées ensemble (422)', async () => {
    const res = await request(appAvec(validate(schema))).post('/t').send({ texte: 'trop long' });
    expect(res.status).toBe(422);
    expect(res.body.details).toHaveLength(2);
  });
  test('chaîne de requête : la valeur validée remplace bien req.query sous Express 5', async () => {
    const res = await request(appAvec(validate(Joi.object({ nombre: Joi.number() }), 'query'))).get('/t?nombre=7&x=1');
    expect(res.body.query).toEqual({ nombre: 7 });
  });
});

describe('téléversement : type réel déterminé par la signature binaire', () => {
  const sharp = require('sharp');
  test.each([
    ['jpg', Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])],
    ['pdf', Buffer.from('%PDF-1.7\n1 0 obj')],
    ['webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])],
    ['mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(4)])],
    ['mov', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  '), Buffer.alloc(4)])],
    ['webm', Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0, 0, 0, 0, 0])],
    [null, Buffer.from('MZ exécutable Windows...')],
    [null, Buffer.from('<html><script>')],
    [null, Buffer.alloc(3)],
    [null, null],
  ])('%s', (attendu, buffer) => expect(detecterType(buffer)).toBe(attendu));

  test('fichier déguisé refusé, image acceptée, fichier manquant signalé', async () => {
    const app = appAvec(recevoirFichier('image'));
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).png().toBuffer();
    expect((await request(app).post('/t').attach('fichier', png, 'a.png')).body.fichier).toEqual({ type: 'png', taille: png.length });
    const faux = await request(app).post('/t').attach('fichier', Buffer.from('%PDF-1.4 pas une image'), 'a.png');
    expect(faux.body.error.code).toBe('FORMAT_FICHIER_REFUSE');
    expect((await request(app).post('/t').send({})).body.error.code).toBe('FICHIER_MANQUANT');
    const facultatif = appAvec(recevoirFichier('image', { obligatoire: false }));
    expect((await request(facultatif).post('/t').send({})).status).toBe(200);
  });
});

describe('contrôle d’accès vertical', () => {
  const executer = (mw, req) => new Promise((resolve) => mw(req, {}, resolve));
  test('rôle, permission, espace propriétaire', async () => {
    expect(await executer(requireRole('admin'), { user: { role_code: 'admin' } })).toBeUndefined();
    expect((await executer(requireRole('admin'), { user: { role_code: 'x' } })).code).toBe('ROLE_INSUFFISANT');
    expect((await executer(requireRole('admin'), {})).statusCode).toBe(401);
    expect(await executer(requirePermission('p'), { user: {}, permissions: new Set(['p']) })).toBeUndefined();
    expect((await executer(requirePermission('p'), { user: {}, permissions: new Set() })).code).toBe('PERMISSION_REFUSEE');
    expect((await executer(requireProprietaire, { user: {} })).code).toBe('ESPACE_PROPRIETAIRE_REQUIS');
    expect((await executer(requireProprietaire, { user: {}, ownerId: 'o', ownerStatus: 'suspendu' })).code).toBe('ESPACE_SUSPENDU');
    expect(await executer(requireProprietaire, { user: {}, ownerId: 'o', ownerStatus: 'actif' })).toBeUndefined();
  });
});
