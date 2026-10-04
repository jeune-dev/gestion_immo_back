'use strict';

const crypto = require('crypto');
const {
  api, bearer, nouveauProprietaire, superAdmin, proprietaireEtLocataire, fermer, sequelize, compter, expirerAbonnement,
} = require('../../../setup/helpers.js');
const {
  PAYDUNYA_PLATEFORME, simulerFournisseurs, configurerPlateforme, retirerPlateforme, factureDe, enFormulaire,
  ipn: ipnPaydunya, ligne, verifierAuthentification, verifierCompteDesactive, restreindrePermissions,
} = require('../paiements/outils.paiements.js');
const AbonnementService = require('../../../../modules/abonnement/service/abonnement.service.js');
const cache = require('../../../../utils/cache.js');
const { aujourdhui, ajouterMois } = require('../../../../utils/dates.js');

/**
 * Abonnements SaaS (§ 31) — API propriétaire :
 *   GET /abonnement/plans (public) · GET /abonnement · GET /abonnement/paiements · POST /abonnement/souscrire
 * et non-régression de l'IPN reçue après un échec / une annulation (constat #7).
 */

/** IPN PayDunya d'une facture d'abonnement (clés de la PLATEFORME) ; la facture évolue chez PayDunya. */
const ipn = (reference, montant, statut = 'completed') => ipnPaydunya(reference, montant, statut, { cles: PAYDUNYA_PLATEFORME });

const souscrire = (p, corps, entetes = {}) => api().post('/api/v1/abonnement/souscrire').set(p.h).set(entetes).send(corps);
const courant = (ownerId) => ligne(
  "SELECT s.status, s.current_period_start, s.current_period_end, pl.code FROM subscriptions s JOIN subscription_plans pl ON pl.id = s.plan_id WHERE s.owner_id = :o AND s.status IN ('essai','actif','suspendu')",
  { o: ownerId }
);

describe('Abonnement — API', () => {
  let fournisseurs;
  beforeAll(() => {
    // Identifiants PayDunya de la PLATEFORME, lus à l'appel.
    configurerPlateforme();
    fournisseurs = simulerFournisseurs();
  });
  afterEach(() => fournisseurs.mode('ok'));
  afterAll(async () => {
    fournisseurs.restaurer();
    retirerPlateforme();
    await fermer();
  });

  describe('#7 IPN valide reçue après un échec ou une annulation', () => {
    test('paiement « échoué » (montant incorrect) puis confirmation au bon montant : abonnement ACTIVÉ, reprise tracée', async () => {
      const p = await nouveauProprietaire();
      const { payment } = (await souscrire(p, { plan_code: 'STARTER', months: 1 })).body.data;
      const montant = Number(payment.amount);
      expect(await AbonnementService.traiterIpnPaydunya(ipn(payment.reference, montant - 1))).toMatchObject({ ok: false, motif: 'montant_incorrect' });
      expect((await ligne('SELECT status FROM subscription_payments WHERE reference = :r', { r: payment.reference })).status).toBe('echoue');

      const r = await AbonnementService.traiterIpnPaydunya(ipn(payment.reference, montant));
      expect(r).toMatchObject({ ok: true, statut: 'confirme', reprise_apres: 'echoue' });
      expect(await courant(p.ownerId)).toMatchObject({ status: 'actif', code: 'STARTER', current_period_end: ajouterMois(aujourdhui(), 1) });
      expect((await ligne('SELECT status, paid_at FROM subscription_payments WHERE reference = :r', { r: payment.reference })).status).toBe('confirme');
      const audit = await ligne("SELECT details FROM audit_logs WHERE action = 'abonnement.paiement' AND owner_id = :o", { o: p.ownerId });
      expect(audit.details.reprise_apres).toBe('echoue');
      // Idempotent une fois confirmé.
      expect(await AbonnementService.traiterIpnPaydunya(ipn(payment.reference, montant))).toMatchObject({ ok: true, deja: true });
      expect((await courant(p.ownerId)).current_period_end).toBe(ajouterMois(aujourdhui(), 1));
    });

    test('paiement « annulé » puis facture payée chez PayDunya (via le webhook) : abonnement ACTIVÉ', async () => {
      const p = await nouveauProprietaire();
      const { payment } = (await souscrire(p, { plan_code: 'PRO', months: 2 })).body.data;
      const montant = Number(payment.amount);
      const url = '/api/v1/webhooks/abonnement/paydunya';
      expect((await api().post(url).type('form').send(enFormulaire(ipn(payment.reference, montant, 'cancelled')))).status).toBe(200);
      expect((await courant(p.ownerId)).status).toBe('essai');
      // Seconde annulation : idempotente.
      expect(await AbonnementService.traiterIpnPaydunya(ipn(payment.reference, montant, 'cancelled'))).toMatchObject({ ok: true, deja: true, statut: 'annule' });
      expect((await api().post(url).type('form').send(enFormulaire(ipn(payment.reference, montant)))).status).toBe(200);
      expect(await courant(p.ownerId)).toMatchObject({ status: 'actif', code: 'PRO', current_period_end: ajouterMois(aujourdhui(), 2) });
    });

    test('une confirmation n’est jamais rétrogradée par une annulation reçue ensuite', async () => {
      const p = await nouveauProprietaire();
      const { payment } = (await souscrire(p, { plan_code: 'STARTER', months: 1 })).body.data;
      await AbonnementService.traiterIpnPaydunya(ipn(payment.reference, Number(payment.amount)));
      expect(await AbonnementService.traiterIpnPaydunya(ipn(payment.reference, Number(payment.amount), 'cancelled'))).toMatchObject({ ok: true, deja: true, statut: 'confirme' });
      expect((await courant(p.ownerId)).status).toBe('actif');
    });
  });

  describe('GET /abonnement/plans (public)', () => {
    test('sans authentification (même avec un jeton invalide) : formules actives, triées, sans champ interne', async () => {
      await cache.invalider('abonnement:plans:publics').catch(() => {});
      const res = await api().get('/api/v1/abonnement/plans').set(bearer('jeton.invalide'));
      expect(res.status).toBe(200);
      const plans = res.body.data.plans;
      expect(plans.map((x) => x.code)).toEqual(expect.arrayContaining(['STARTER', 'BUSINESS', 'PRO']));
      for (const plan of plans) {
        expect(Object.keys(plan).sort()).toEqual(['billing_period', 'code', 'currency', 'description', 'features', 'limits', 'name', 'price'].sort());
        expect(Number.isInteger(plan.price)).toBe(true);
      }
      expect(plans.findIndex((x) => x.code === 'STARTER')).toBeLessThan(plans.findIndex((x) => x.code === 'PRO'));
    });
  });

  describe('authentification et autorisations', () => {
    const routes = [
      ['GET', '/api/v1/abonnement', null],
      ['GET', '/api/v1/abonnement/paiements', null],
      ['POST', '/api/v1/abonnement/souscrire', { plan_code: 'STARTER', months: 1 }],
    ];

    test.each(routes)('%s %s : 401 sans jeton valide', async (m, url, c) => {
      await verifierAuthentification(m, url, await nouveauProprietaire(), c);
    });

    test('compte désactivé → 403 ; locataire et super admin → 403', async () => {
      const { proprio: p, locataire } = await proprietaireEtLocataire();
      const admin = await superAdmin();
      for (const compte of [locataire, admin]) {
        for (const [m, url, c] of routes) {
          const r = api()[m.toLowerCase()](url).set(compte.h);
          const res = m === 'GET' ? await r : await r.send(c);
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('ESPACE_PROPRIETAIRE_REQUIS');
        }
      }
      await verifierCompteDesactive(routes, p);
    });

    test('permission « abonnement.gerer » requise sur les trois routes', async () => {
      const p = await nouveauProprietaire();
      await restreindrePermissions(p, ['paiements.lire']);
      for (const [m, url, c] of routes) {
        const r = api()[m.toLowerCase()](url).set(p.h);
        const res = m === 'GET' ? await r : await r.send(c);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('PERMISSION_REFUSEE');
      }
      expect(await compter('subscription_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });
  });

  describe('GET /abonnement et /abonnement/paiements', () => {
    test('état après expiration : inactif, consultation toujours possible', async () => {
      const p = await nouveauProprietaire();
      await expirerAbonnement(p.ownerId);
      const res = await api().get('/api/v1/abonnement').set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.abonnement.actif).toBe(false);
      expect(res.body.data.abonnement.usage).toMatchObject({ buildings: { used: 0 }, apartments: { used: 0 } });
    });

    test('historique : pagination exacte, filtre de statut, sans charge brute, isolé par propriétaire', async () => {
      const p = await nouveauProprietaire();
      const autre = await nouveauProprietaire();
      const a = (await souscrire(p, { plan_code: 'STARTER', months: 1 })).body.data.payment;
      await souscrire(p, { plan_code: 'PRO', months: 1 });
      await souscrire(autre, { plan_code: 'STARTER', months: 1 });
      await AbonnementService.traiterIpnPaydunya(ipn(a.reference, Number(a.amount)));
      const p1 = await api().get('/api/v1/abonnement/paiements?limit=1').set(p.h);
      expect(p1.status).toBe(200);
      expect(p1.body.data.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
      expect(p1.body.data.items[0]).not.toHaveProperty('raw_payload');
      expect(p1.body.data.items[0].plan).toHaveProperty('code');
      const p2 = await api().get('/api/v1/abonnement/paiements?limit=1&page=2').set(p.h);
      expect(p2.body.data.items[0].id).not.toBe(p1.body.data.items[0].id);
      expect((await api().get('/api/v1/abonnement/paiements?page=9').set(p.h)).body.data.items).toEqual([]);
      const confirmes = await api().get('/api/v1/abonnement/paiements?status=confirme').set(p.h);
      expect(confirmes.body.data.items.map((x) => x.reference)).toEqual([a.reference]);
      expect((await api().get('/api/v1/abonnement/paiements?limit=1000').set(p.h)).body.data.pagination.limit).toBe(100);
      for (const qs of ['status=paye', 'page=0', 'limit=0', 'limit=x']) {
        expect((await api().get(`/api/v1/abonnement/paiements?${qs}`).set(p.h)).status).toBe(422);
      }
    });
  });

  describe('POST /abonnement/souscrire', () => {
    test.each([
      ['corps vide', {}],
      ['formule absente', { months: 1 }],
      ['durée absente', { plan_code: 'STARTER' }],
      ['durée nulle', { plan_code: 'STARTER', months: 0 }],
      ['durée négative', { plan_code: 'STARTER', months: -1 }],
      ['durée > 12', { plan_code: 'STARTER', months: 13 }],
      ['durée décimale', { plan_code: 'STARTER', months: 1.5 }],
      ['durée texte', { plan_code: 'STARTER', months: 'un' }],
      ['code trop long', { plan_code: 'S'.repeat(31), months: 1 }],
      ['portefeuille inconnu', { plan_code: 'STARTER', months: 1, wallet: 'paypal' }],
    ])('validation — %s → 422, aucune demande', async (_l, corps) => {
      const p = await nouveauProprietaire();
      const res = await souscrire(p, corps);
      expect(res.status).toBe(422);
      expect(await compter('subscription_payments', 'owner_id = :o', { o: p.ownerId })).toBe(0);
    });

    test('formule inconnue ou inactive → 422 PLAN_INDISPONIBLE ; formule gratuite → 409 PLAN_GRATUIT', async () => {
      const p = await nouveauProprietaire();
      expect((await souscrire(p, { plan_code: 'INCONNU', months: 1 })).body.error.code).toBe('PLAN_INDISPONIBLE');
      const code = `GRATUIT${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      await sequelize.query("INSERT INTO subscription_plans (code, name, price, features, status) VALUES (:code, 'Gratuit', 0, '{}', 'actif')", { replacements: { code } });
      const gratuit = await souscrire(p, { plan_code: code.toLowerCase(), months: 3 });
      expect(gratuit.status).toBe(409);
      expect(gratuit.body.error.code).toBe('PLAN_GRATUIT');
      await sequelize.query("UPDATE subscription_plans SET status = 'inactif', price = 1000 WHERE code = :code", { replacements: { code } });
      expect((await souscrire(p, { plan_code: code, months: 1 })).body.error.code).toBe('PLAN_INDISPONIBLE');
    });

    test('facture PayDunya avec canal ciblé ; montant = prix × mois ; rien n’est activé avant l’IPN', async () => {
      const p = await nouveauProprietaire();
      const res = await souscrire(p, { plan_code: 'business', months: 6, wallet: 'orange_money' });
      expect(res.status).toBe(201);
      const [[{ price }]] = await sequelize.query("SELECT price FROM subscription_plans WHERE code = 'BUSINESS'");
      expect(Number(res.body.data.payment.amount)).toBe(Number(price) * 6);
      const appel = fournisseurs.appels[fournisseurs.appels.length - 1];
      expect(appel.corps).toMatchObject({
        invoice: { total_amount: Number(price) * 6, channels: ['orange-money-senegal'] },
        custom_data: { reference: res.body.data.payment.reference },
      });
      expect(res.body.data.checkout_url).toBe(`https://app.paydunya.com/sandbox-checkout/invoice/${factureDe(res.body.data.payment.reference).token}`);
      expect(appel.corps.actions.cancel_url).toMatch(/^http:\/\/localhost:5173\/abonnement\/paiement\/annule\?reference=ABO-/);
      expect(appel.corps.actions.return_url).toMatch(/^http:\/\/localhost:5173\/abonnement\/paiement\/succes\?reference=ABO-/);
      expect((await courant(p.ownerId)).status).toBe('essai');
    });

    test('PayDunya indisponible ou refusant : 503, demande close « échoué » ; nouvel essai avec la même clé traité', async () => {
      const p = await nouveauProprietaire();
      fournisseurs.mode('refus');
      const cle = crypto.randomUUID();
      const refus = await souscrire(p, { plan_code: 'STARTER', months: 1 }, { 'Idempotency-Key': cle });
      expect(refus.status).toBe(503);
      expect(refus.body.error.code).toBe('PAIEMENT_INDISPONIBLE');
      expect((await ligne('SELECT status, note FROM subscription_payments WHERE owner_id = :o', { o: p.ownerId })).status).toBe('echoue');
      fournisseurs.mode('ok');
      const reprise = await souscrire(p, { plan_code: 'STARTER', months: 1 }, { 'Idempotency-Key': cle });
      expect(reprise.status).toBe(201);
      expect(reprise.headers['idempotent-replayed']).toBeUndefined();
      expect(await compter('subscription_payments', 'owner_id = :o', { o: p.ownerId })).toBe(2);
    });

    test('adresses publiques absentes → 503 PAIEMENT_NON_CONFIGURE', async () => {
      const p = await nouveauProprietaire();
      const valeur = process.env.APP_PUBLIC_URL;
      delete process.env.APP_PUBLIC_URL;
      try {
        const res = await souscrire(p, { plan_code: 'STARTER', months: 1 });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('PAIEMENT_NON_CONFIGURE');
      } finally {
        process.env.APP_PUBLIC_URL = valeur;
      }
    });

    test('§ 44 double clic (même clé, simultané) : une seule demande de paiement', async () => {
      const p = await nouveauProprietaire();
      const cle = crypto.randomUUID();
      const reponses = await Promise.all([1, 2, 3].map(() => souscrire(p, { plan_code: 'STARTER', months: 1 }, { 'Idempotency-Key': cle })));
      expect(reponses.some((r) => r.status === 201)).toBe(true);
      for (const r of reponses) expect([201, 409]).toContain(r.status);
      expect(await compter('subscription_payments', 'owner_id = :o', { o: p.ownerId })).toBe(1);
    });

    test('§ 31 abonnement échu : l’espace est en lecture seule MAIS la souscription reste possible par l’API', async () => {
      const p = await nouveauProprietaire();
      await expirerAbonnement(p.ownerId);
      await AbonnementService.expirerAbonnements();
      expect((await api().post('/api/v1/immeubles').set(p.h).send({ name: 'X', address: 'Y', city: 'Dakar' })).status).toBe(402);
      const res = await souscrire(p, { plan_code: 'STARTER', months: 1 });
      expect(res.status).toBe(201);
      await AbonnementService.traiterIpnPaydunya(ipn(res.body.data.payment.reference, Number(res.body.data.payment.amount)));
      expect((await courant(p.ownerId)).status).toBe('actif');
      expect((await api().post('/api/v1/immeubles').set(p.h).send({ name: 'Résidence Test', address: 'Plateau', city: 'Dakar' })).status).toBe(201);
    });
  });
});
