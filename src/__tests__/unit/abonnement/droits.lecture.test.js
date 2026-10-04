'use strict';

/**
 * § 31 — fonctionnalités de la formule et LECTURE SEULE (audit #24) : un
 * abonnement échu ou suspendu laisse consulter ce que la formule incluait
 * (rapports…), mais toute écriture exige l'abonnement actif. Modèles et cache
 * simulés : aucune base.
 */

jest.mock('../../../models/index.js', () => ({
  Subscription: { findOne: jest.fn() },
  SubscriptionPlan: {},
  Building: {},
  Apartment: {},
  MessageDelivery: {},
  Owner: {},
}));
jest.mock('../../../utils/cache.js', () => ({
  lire: jest.fn(async () => null),
  ecrire: jest.fn(async () => {}),
  invalider: jest.fn(async () => {}),
}));

const { Subscription } = require('../../../models/index.js');
const droits = require('../../../modules/abonnement/service/droits.service.js');
const { exigerFonctionnalite } = require('../../../middlewares/abonnement.middleware.js');

const FUTUR = '2999-12-31';
const PASSE = '2020-01-01';
const plan = (features) => ({ code: 'X', name: 'X', max_buildings: null, max_apartments: null, max_whatsapp_per_month: null, features });

/**
 * Simule la base : `courant` = abonnement essai/actif/suspendu (ou null),
 * `dernier` = dernier abonnement quel que soit son statut (ou null).
 */
function base({ courant = null, dernier = null }) {
  Subscription.findOne.mockImplementation(async ({ where }) => (where.status ? courant : dernier));
}

const erreur = async (promesse) => promesse.then(() => null, (e) => ({ statut: e.statusCode, code: e.code }));

beforeEach(() => Subscription.findOne.mockReset());

describe('exigerFonctionnalite', () => {
  test('abonnement actif incluant la fonctionnalité : lecture et écriture permises', async () => {
    base({ courant: { id: 's', status: 'actif', current_period_end: FUTUR, plan: plan(['rapports']) } });
    expect(await erreur(droits.exigerFonctionnalite('o', 'rapports'))).toBeNull();
    expect(await erreur(droits.exigerFonctionnalite('o', 'rapports', { lecture: true }))).toBeNull();
  });

  test('période échue : LECTURE permise, écriture 402 ABONNEMENT_REQUIS', async () => {
    base({ courant: { id: 's', status: 'essai', current_period_end: PASSE, plan: plan(['rapports']) } });
    expect(await erreur(droits.exigerFonctionnalite('o', 'rapports', { lecture: true }))).toBeNull();
    expect(await erreur(droits.exigerFonctionnalite('o', 'rapports'))).toEqual({ statut: 402, code: 'ABONNEMENT_REQUIS' });
  });

  test('suspendu : lecture permise, écriture 402', async () => {
    base({ courant: { id: 's', status: 'suspendu', current_period_end: FUTUR, plan: plan(['rapports']) } });
    expect(await erreur(droits.exigerFonctionnalite('o', 'rapports', { lecture: true }))).toBeNull();
    expect((await erreur(droits.exigerFonctionnalite('o', 'rapports'))).statut).toBe(402);
  });

  test('plus d’abonnement courant (expiré par le job) : la formule du DERNIER abonnement vaut pour la lecture', async () => {
    base({ courant: null, dernier: { plan: { features: ['rapports'] } } });
    expect(await erreur(droits.exigerFonctionnalite('o', 'rapports', { lecture: true }))).toBeNull();
    expect((await erreur(droits.exigerFonctionnalite('o', 'rapports'))).statut).toBe(402);
    expect(await erreur(droits.exigerFonctionnalite('o', 'messagerie', { lecture: true }))).toEqual({ statut: 403, code: 'FONCTIONNALITE_NON_INCLUSE' });
  });

  test('aucun abonnement connu : 402 même en lecture', async () => {
    base({ courant: null, dernier: null });
    expect((await erreur(droits.exigerFonctionnalite('o', 'rapports', { lecture: true }))).statut).toBe(402);
  });

  test('fonctionnalité absente de la formule : 403 en lecture comme en écriture', async () => {
    base({ courant: { id: 's', status: 'actif', current_period_end: FUTUR, plan: plan(['messagerie']) } });
    expect(await erreur(droits.exigerFonctionnalite('o', 'rapports', { lecture: true }))).toEqual({ statut: 403, code: 'FONCTIONNALITE_NON_INCLUSE' });
    expect(await erreur(droits.exigerFonctionnalite('o', 'rapports'))).toEqual({ statut: 403, code: 'FONCTIONNALITE_NON_INCLUSE' });
  });

  test('aFonctionnalite (usages automatiques) exige toujours l’abonnement actif', async () => {
    base({ courant: { id: 's', status: 'essai', current_period_end: PASSE, plan: plan(['messagerie']) } });
    expect(await droits.aFonctionnalite('o', 'messagerie')).toBe(false);
  });
});

describe('middleware exigerFonctionnalite : lecture selon la méthode HTTP', () => {
  const appeler = (methode) => new Promise((resolve) => {
    exigerFonctionnalite('rapports')({ method: methode, ownerId: 'o' }, {}, (err) => resolve(err ? err.statusCode : 'suivant'));
  });

  test('GET et HEAD passent sur un abonnement échu ; POST, PATCH, DELETE → 402', async () => {
    base({ courant: { id: 's', status: 'actif', current_period_end: PASSE, plan: plan(['rapports']) } });
    expect(await appeler('GET')).toBe('suivant');
    expect(await appeler('HEAD')).toBe('suivant');
    expect(await appeler('POST')).toBe(402);
    expect(await appeler('PATCH')).toBe(402);
    expect(await appeler('DELETE')).toBe(402);
  });
});
