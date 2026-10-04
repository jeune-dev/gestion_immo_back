'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  api, bearer, nouveauProprietaire, proprietaireEtLocataire, expirerAbonnement, fermer, sequelize,
} = require('../../../setup/helpers.js');
const roles = require('../../../../modules/auth/service/roles.service.js');
const droits = require('../../../../modules/abonnement/service/droits.service.js');

/**
 * Matrice de sécurité de TOUTES les routes du domaine « exploitation » :
 * factures communes, charges, dépenses, catégories, caisse, travaux, artisans,
 * incidents, tableau de bord, rapports, et leurs routes locataire.
 *
 *   B — authentification (§ 32) : jeton absent, invalide, expiré, de mauvais
 *       type, signé avec un autre secret, périmé par token_version, compte
 *       désactivé ;
 *   C — autorisation : locataire sur une route propriétaire, propriétaire sur
 *       une route locataire, permission manquante, espace suspendu ;
 *   § 31 — abonnement échu : toute écriture 402, toute lecture permise.
 *
 * Aucune de ces requêtes ne doit atteindre la logique métier : les tables
 * métier restent inchangées.
 */

jest.setTimeout(120000);

const ID = crypto.randomUUID();
const ID2 = crypto.randomUUID();

/** [méthode, chemin] — une ligne par route (liste de scripts/lister-routes.js). */
const ROUTES_PROPRIETAIRE = [
  ['get', '/api/v1/dashboard'],
  ['get', '/api/v1/dashboard/graphiques'],
  ['get', '/api/v1/factures-communes'],
  ['get', '/api/v1/factures-communes/a-repartir'],
  ['post', '/api/v1/factures-communes'],
  ['get', `/api/v1/factures-communes/${ID}`],
  ['patch', `/api/v1/factures-communes/${ID}`],
  ['post', `/api/v1/factures-communes/${ID}/document`],
  ['get', `/api/v1/factures-communes/${ID}/apercu`],
  ['post', `/api/v1/factures-communes/${ID}/apercu`],
  ['post', `/api/v1/factures-communes/${ID}/repartir`],
  ['post', `/api/v1/factures-communes/${ID}/annuler`],
  ['get', '/api/v1/charges'],
  ['get', `/api/v1/charges/${ID}`],
  ['get', '/api/v1/depenses'],
  ['post', '/api/v1/depenses'],
  ['get', `/api/v1/depenses/${ID}`],
  ['patch', `/api/v1/depenses/${ID}`],
  ['post', `/api/v1/depenses/${ID}/annuler`],
  ['post', `/api/v1/depenses/${ID}/justificatifs`],
  ['get', '/api/v1/categories-depenses'],
  ['post', '/api/v1/categories-depenses'],
  ['patch', `/api/v1/categories-depenses/${ID}`],
  ['post', `/api/v1/categories-depenses/${ID}/desactiver`],
  ['get', '/api/v1/caisse'],
  ['get', '/api/v1/caisse/synthese'],
  ['post', '/api/v1/caisse/autres-revenus'],
  ['post', `/api/v1/caisse/${ID}/annuler`],
  ['get', '/api/v1/travaux'],
  ['post', '/api/v1/travaux'],
  ['get', `/api/v1/travaux/${ID}`],
  ['patch', `/api/v1/travaux/${ID}`],
  ['post', `/api/v1/travaux/${ID}/statut`],
  ['get', `/api/v1/travaux/${ID}/photos`],
  ['post', `/api/v1/travaux/${ID}/photos`],
  ['delete', `/api/v1/travaux/${ID}/photos/${ID2}`],
  ['post', `/api/v1/travaux/${ID}/depenses`],
  ['get', '/api/v1/artisans'],
  ['post', '/api/v1/artisans'],
  ['get', `/api/v1/artisans/${ID}`],
  ['patch', `/api/v1/artisans/${ID}`],
  ['post', `/api/v1/artisans/${ID}/desactiver`],
  ['post', `/api/v1/artisans/${ID}/reactiver`],
  ['delete', `/api/v1/artisans/${ID}`],
  ['get', '/api/v1/incidents'],
  ['post', '/api/v1/incidents'],
  ['get', `/api/v1/incidents/${ID}`],
  ['post', `/api/v1/incidents/${ID}/analyser`],
  ['post', `/api/v1/incidents/${ID}/rejeter`],
  ['post', `/api/v1/incidents/${ID}/resoudre`],
  ['post', `/api/v1/incidents/${ID}/travaux`],
  ['get', '/api/v1/rapports/financier'],
  ['get', '/api/v1/rapports/immobilier'],
  ['get', '/api/v1/rapports/travaux'],
  ['get', '/api/v1/rapports/locataires'],
  ['get', '/api/v1/rapports/rentabilite'],
];

const ROUTES_LOCATAIRE = [
  ['get', '/api/v1/locataire/charges'],
  ['get', `/api/v1/locataire/charges/${ID}`],
  ['get', '/api/v1/locataire/incidents'],
  ['post', '/api/v1/locataire/incidents'],
  ['get', `/api/v1/locataire/incidents/${ID}`],
  ['post', `/api/v1/locataire/incidents/${ID}/pieces`],
];

const TOUTES = [...ROUTES_PROPRIETAIRE, ...ROUTES_LOCATAIRE];
const nom = ([m, c]) => `${m.toUpperCase()} ${c.replace(ID, ':id').replace(ID2, ':photoId')}`;

const appeler = ([methode, chemin], entetes = {}) => api()[methode](chemin).set(entetes).send({});

/** Instantané des tables métier du domaine : aucune requête refusée ne doit les modifier. */
async function instantane() {
  const [[l]] = await sequelize.query(`
    SELECT (SELECT count(*) FROM charge_invoices)::int AS factures, (SELECT count(*) FROM charges)::int AS charges,
           (SELECT count(*) FROM expenses)::int AS depenses, (SELECT count(*) FROM expense_categories)::int AS categories,
           (SELECT count(*) FROM cash_movements)::int AS caisse, (SELECT count(*) FROM work_orders)::int AS travaux,
           (SELECT count(*) FROM contractors)::int AS artisans, (SELECT count(*) FROM incidents)::int AS incidents,
           (SELECT count(*) FROM documents)::int AS documents`);
  return l;
}

const signer = (charge, options = {}) => jwt.sign(charge, process.env.JWT_SECRET, { algorithm: 'HS256', ...options });

describe('Sécurité des routes du domaine', () => {
  let proprio;
  let locataire;
  let avant;

  beforeAll(async () => {
    ({ proprio, locataire } = await proprietaireEtLocataire());
    avant = await instantane();
  });
  afterAll(fermer);

  describe('B — authentification', () => {
    test.each(TOUTES.map((r) => [nom(r), r]))('%s : sans jeton → 401 TOKEN_MANQUANT', async (_n, route) => {
      const res = await appeler(route);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_MANQUANT');
    });

    test.each(TOUTES.map((r) => [nom(r), r]))('%s : jeton illisible, autre schéma ou autre secret → 401', async (_n, route) => {
      expect((await appeler(route, { Authorization: 'Bearer pas.un.jwt' })).status).toBe(401);
      expect((await appeler(route, { Authorization: `Basic ${proprio.token}` })).status).toBe(401);
      const autreSecret = jwt.sign({ sub: proprio.user.id, typ: 'access', tv: 0 }, 'un-autre-secret-de-test', { algorithm: 'HS256' });
      const res = await appeler(route, bearer(autreSecret));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_INVALIDE');
    });

    test.each(TOUTES.map((r) => [nom(r), r]))('%s : jeton expiré → 401 TOKEN_EXPIRE ; jeton non « access » → 401', async (_n, route) => {
      const [[u]] = await sequelize.query('SELECT token_version FROM users WHERE id = :id', { replacements: { id: proprio.user.id } });
      const expire = signer({
        sub: proprio.user.id, role: 'proprietaire', tv: u.token_version, typ: 'access', exp: Math.floor(Date.now() / 1000) - 60,
      });
      const res = await appeler(route, bearer(expire));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TOKEN_EXPIRE');
      const rafraichissement = signer({ sub: proprio.user.id, tv: u.token_version, typ: 'refresh' }, { expiresIn: '5m' });
      expect((await appeler(route, bearer(rafraichissement))).status).toBe(401);
      // alg « none » : jamais accepté.
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const sansSignature = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: proprio.user.id, tv: u.token_version, typ: 'access' })}.`;
      expect((await appeler(route, bearer(sansSignature))).status).toBe(401);
    });

    test('token_version incrémenté (déconnexion de tous les appareils) → 401 SESSION_REVOQUEE sur chaque route', async () => {
      const p = await nouveauProprietaire();
      await sequelize.query('UPDATE users SET token_version = token_version + 1 WHERE id = :id', { replacements: { id: p.user.id } });
      for (const route of ROUTES_PROPRIETAIRE) {
        const res = await appeler(route, p.h);
        expect([nom(route), res.status, res.body.error?.code]).toEqual([nom(route), 401, 'SESSION_REVOQUEE']);
      }
    });

    test('compte désactivé → 403 COMPTE_INACTIF sur chaque route (propriétaire et locataire)', async () => {
      const { proprio: p, locataire: l } = await proprietaireEtLocataire();
      await sequelize.query("UPDATE users SET status = 'inactif' WHERE id IN (:ids)", { replacements: { ids: [p.user.id, l.user.id] } });
      for (const route of ROUTES_PROPRIETAIRE) {
        const res = await appeler(route, p.h);
        expect([nom(route), res.status, res.body.error?.code]).toEqual([nom(route), 403, 'COMPTE_INACTIF']);
      }
      for (const route of ROUTES_LOCATAIRE) {
        const res = await appeler(route, l.h);
        expect([nom(route), res.status, res.body.error?.code]).toEqual([nom(route), 403, 'COMPTE_INACTIF']);
      }
    });
  });

  describe('C — autorisation', () => {
    test.each(ROUTES_PROPRIETAIRE.map((r) => [nom(r), r]))('%s : un locataire → 403 ESPACE_PROPRIETAIRE_REQUIS', async (_n, route) => {
      const res = await appeler(route, locataire.h);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ESPACE_PROPRIETAIRE_REQUIS');
    });

    test.each(ROUTES_LOCATAIRE.map((r) => [nom(r), r]))('%s : un propriétaire → 403 ESPACE_LOCATAIRE_REQUIS', async (_n, route) => {
      const res = await appeler(route, proprio.h);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ESPACE_LOCATAIRE_REQUIS');
    });

    test('rôle d’espace SANS permission → 403 PERMISSION_REFUSEE sur chaque route propriétaire, avant toute validation', async () => {
      const p = await nouveauProprietaire();
      const code = `test_sans_droit_${crypto.randomBytes(4).toString('hex')}`;
      await sequelize.query("INSERT INTO roles (code, label, permissions) VALUES (:code, 'Rôle de test sans droit', ARRAY['compte.lire']::text[])", { replacements: { code } });
      await sequelize.query('UPDATE owner_members SET role_code = :code WHERE owner_id = :o', { replacements: { code, o: p.ownerId } });
      roles.invalider();
      try {
        for (const route of ROUTES_PROPRIETAIRE) {
          const res = await appeler(route, p.h);
          expect([nom(route), res.status, res.body.error?.code]).toEqual([nom(route), 403, 'PERMISSION_REFUSEE']);
        }
      } finally {
        roles.invalider();
      }
    });

    test('rôle en LECTURE seule : lectures autorisées, écritures 403 PERMISSION_REFUSEE', async () => {
      const p = await nouveauProprietaire();
      const code = `test_lecteur_${crypto.randomBytes(4).toString('hex')}`;
      const lectures = ['dashboard.lire', 'charges.lire', 'depenses.lire', 'caisse.lire', 'travaux.lire', 'artisans.lire', 'incidents.lire', 'rapports.lire'];
      await sequelize.query('INSERT INTO roles (code, label, permissions) VALUES (:code, \'Lecteur\', ARRAY[:perms]::text[])', { replacements: { code, perms: lectures } });
      await sequelize.query('UPDATE owner_members SET role_code = :code WHERE owner_id = :o', { replacements: { code, o: p.ownerId } });
      roles.invalider();
      try {
        for (const route of ROUTES_PROPRIETAIRE) {
          const res = await appeler(route, p.h);
          // L'aperçu de répartition en POST (§ 17) n'enregistre rien : permission de LECTURE.
          if (route[0] === 'get' || route[1].endsWith('/apercu')) {
            expect([nom(route), res.status === 403]).toEqual([nom(route), false]);
          } else {
            expect([nom(route), res.status, res.body.error?.code]).toEqual([nom(route), 403, 'PERMISSION_REFUSEE']);
          }
        }
      } finally {
        roles.invalider();
      }
    });

    test('espace propriétaire suspendu → 403 ESPACE_SUSPENDU sur chaque route', async () => {
      const p = await nouveauProprietaire();
      await sequelize.query("UPDATE owners SET status = 'suspendu' WHERE id = :o", { replacements: { o: p.ownerId } });
      for (const route of ROUTES_PROPRIETAIRE) {
        const res = await appeler(route, p.h);
        expect([nom(route), res.status, res.body.error?.code]).toEqual([nom(route), 403, 'ESPACE_SUSPENDU']);
      }
    });
  });

  describe('§ 31 — abonnement échu : lecture seule', () => {
    test('toute ÉCRITURE → 402 ABONNEMENT_REQUIS ; aucune LECTURE → 402', async () => {
      const p = await nouveauProprietaire();
      await expirerAbonnement(p.ownerId);
      try {
        for (const route of ROUTES_PROPRIETAIRE) {
          const res = await api()[route[0]](route[1]).query({ du: '2026-09-01', au: '2026-09-30' }).set(p.h).send({});
          if (route[0] === 'get') {
            expect([nom(route), res.status === 402]).toEqual([nom(route), false]);
          } else {
            expect([nom(route), res.status, res.body.error?.code]).toEqual([nom(route), 402, 'ABONNEMENT_REQUIS']);
          }
        }
      } finally {
        await droits.invalider(p.ownerId);
      }
    });
  });

  test('aucune des requêtes refusées n’a modifié les tables métier du propriétaire de référence', async () => {
    const apres = await instantane();
    // Les autres tests de ce fichier créent des propriétaires (catégories globales inchangées) mais aucune ligne métier.
    expect(apres).toEqual(avant);
  });
});
