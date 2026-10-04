'use strict';

const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const { recevoirFichier, etatMemoire } = require('../../../middlewares/upload.middleware.js');
const { uploadConfig } = require('../../../config/security.js');
const errorHandler = require('../../../middlewares/errorHandler.middleware.js');

/**
 * CORRECTIF E3 de l'audit de sécurité — téléversements à mémoire BORNÉE.
 * Sans borne, une rafale de vidéos de 60 Mo lues en mémoire faisait
 * redémarrer le processus (déni de service). Désormais : budget mémoire par
 * processus réservé avant lecture, envois simultanés plafonnés par
 * utilisateur, corps trop gros refusé sans être lu, réservation TOUJOURS
 * libérée (succès, refus, coupure).
 */

const REGLAGES = { ...uploadConfig };
afterEach(() => {
  Object.assign(uploadConfig, REGLAGES);
  etatMemoire.reserve = 0;
  etatMemoire.parUtilisateur.clear();
});

/** Application minimale ; `attente` retient la réponse (téléversement « en cours »). */
function application({ attente = null } = {}) {
  const app = express();
  app.post('/t', recevoirFichier('image'), async (req, res) => {
    if (attente) await attente;
    res.json({ taille: req.fichier.taille });
  });
  app.use(errorHandler);
  return app;
}

// Bruit aléatoire : incompressible (~120 Ko), taille d'envoi réaliste et stable.
let png;
beforeAll(async () => {
  const bruit = require('crypto').randomBytes(200 * 200 * 3);
  png = await sharp(bruit, { raw: { width: 200, height: 200, channels: 3 } }).png().toBuffer();
});

describe('Téléversements : mémoire bornée', () => {
  test('envoi refusé (budget épuisé) : corps lu et JETÉ, réponse propre — jamais de coupure réseau', async () => {
    uploadConfig.memoireMaxOctets = 1024;
    const gros = Buffer.alloc(3 * 1024 * 1024, 7);
    const res = await request(application()).post('/t').attach('fichier', gros, 'a.png');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TELEVERSEMENTS_SATURES');
    expect(etatMemoire.reserve).toBe(0);
  });

  test('corps plus gros que le plafond de la route : réservation plafonnée, 400 propre', async () => {
    uploadConfig.maxImageBytes = 50 * 1024;
    const res = await request(application()).post('/t').attach('fichier', Buffer.alloc(400 * 1024, 1), 'a.png');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FICHIER_TROP_VOLUMINEUX');
    expect(etatMemoire.reserve).toBe(0);
  });

  test('budget mémoire du processus épuisé → 503 TELEVERSEMENTS_SATURES avec Retry-After', async () => {
    uploadConfig.memoireMaxOctets = Math.floor(png.length / 2); // plus petit que l'envoi
    const res = await request(application()).post('/t').attach('fichier', png, 'a.png');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TELEVERSEMENTS_SATURES');
    expect(res.headers['retry-after']).toBe('5');
    expect(etatMemoire.reserve).toBe(0);
  });

  test('envois simultanés d’un même utilisateur plafonnés (429), les autres passent ensuite', async () => {
    uploadConfig.simultanesParUtilisateur = 2;
    let liberer;
    const attente = new Promise((r) => { liberer = r; });
    const app = application({ attente });
    const enCours = [1, 2].map(() => request(app).post('/t').attach('fichier', png, 'a.png').then((r) => r));
    // Laisse les deux premiers réserver leur place.
    await new Promise((r) => setTimeout(r, 150));
    const troisieme = await request(app).post('/t').attach('fichier', png, 'a.png');
    expect(troisieme.status).toBe(429);
    expect(troisieme.body.error.code).toBe('TELEVERSEMENTS_SIMULTANES');
    liberer();
    expect((await Promise.all(enCours)).map((r) => r.status)).toEqual([200, 200]);
    expect((await request(app).post('/t').attach('fichier', png, 'a.png')).status).toBe(200);
  });

  test('rafale : jamais plus que le budget en mémoire à la fois', async () => {
    uploadConfig.simultanesParUtilisateur = 100;
    // Place pour 3 envois (taille annoncée ≈ fichier + enveloppe multipart).
    uploadConfig.memoireMaxOctets = Math.floor(3.5 * (png.length + 400));
    let liberer;
    const attente = new Promise((r) => { liberer = r; });
    const app = application({ attente });
    const envois = Array.from({ length: 8 }, () => request(app).post('/t').attach('fichier', png, 'a.png').then((r) => r));
    await new Promise((r) => setTimeout(r, 300));
    expect(etatMemoire.reserve).toBeLessThanOrEqual(uploadConfig.memoireMaxOctets);
    liberer();
    const statuts = (await Promise.all(envois)).map((r) => r.status);
    expect(statuts.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuts.filter((s) => s === 200).length).toBeLessThanOrEqual(3);
    expect(statuts.every((s) => s === 200 || s === 503)).toBe(true);
  });

  test('requête SANS fichier (JSON) : ni mémoire réservée ni place d’envoi consommée', async () => {
    uploadConfig.simultanesParUtilisateur = 1;
    const app = express();
    app.use(express.json());
    app.post('/t', recevoirFichier('image', { obligatoire: false }), (req, res) => res.json({ fichier: Boolean(req.fichier) }));
    app.use(errorHandler);
    const res = await Promise.all([1, 2, 3].map(() => request(app).post('/t').send({ a: 1 })));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(etatMemoire.reserve).toBe(0);
  });

  test('réservation libérée après succès ET après refus du fichier', async () => {
    const app = application();
    expect((await request(app).post('/t').attach('fichier', png, 'a.png')).status).toBe(200);
    expect((await request(app).post('/t').attach('fichier', Buffer.from('%PDF-1.4 pas une image'), 'a.png')).status).toBe(400);
    expect((await request(app).post('/t').send({})).status).toBe(400);
    expect(etatMemoire.reserve).toBe(0);
    expect(etatMemoire.parUtilisateur.size).toBe(0);
  });
});
