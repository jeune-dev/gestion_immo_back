'use strict';

// La liste des routes est lue sur le routeur RÉEL : ce module doit être chargé
// avant l'application (il instrumente Express pour connaître les montages).
const { listerRoutes } = require('../../../../scripts/lister-routes.js');
const jwt = require('jsonwebtoken');
const {
  api, bearer, nouveauProprietaire, superAdmin, proprietaireEtLocataire, fermer, sequelize,
} = require('../../setup/helpers.js');
const { jeuComplet, resoudreParametres } = require('../../setup/jeuComplet.js');

/**
 * MATRICES DE SÉCURITÉ sur TOUTES les routes de l'API (§ 32, § 43).
 *
 * Aucune route n'est listée à la main : elles sont lues sur l'application.
 * Une route ajoutée demain est donc automatiquement soumise à ces contrôles —
 * et une route paramétrée que la matrice IDOR ne sait pas alimenter fait
 * échouer le test (elle ne peut pas passer inaperçue).
 */

const UUID = '6f1c8a52-7d2e-4f4b-9a3c-0b1d2e3f4a5b';
const ROUTES = listerRoutes().filter((r) => r.chemin.startsWith('/api/v1/'));

/** Espace d'une route : public, authentifié, propriétaire, locataire, admin. */
function espace(chemin) {
  if (/^\/api\/v1\/(auth|referentiels|webhooks)\//.test(`${chemin}/`) || chemin.startsWith('/api/v1/abonnement/plans')) return 'public';
  if (/^\/api\/v1\/(compte|notifications|documents)(\/|$)/.test(chemin)) return 'authentifie';
  if (chemin.startsWith('/api/v1/locataire/')) return 'locataire';
  if (chemin.startsWith('/api/v1/admin/')) return 'admin';
  return 'proprietaire';
}

const avecUuid = (chemin) => chemin.replace(/:[A-Za-z]+/g, UUID);
const appeler = (methode, url, entetes = {}) => api()[methode.toLowerCase()](url).set(entetes).send({});
const PROTEGEES = ROUTES.filter((r) => espace(r.chemin) !== 'public');

/** Empreinte de toutes les données d'un propriétaire (preuve qu'aucune écriture n'a eu lieu). */
async function empreinte(ownerId) {
  const tables = [
    'buildings', 'apartments', 'tenants', 'leases', 'rent_schedules', 'rent_payments', 'payment_allocations', 'receipts',
    'deposits', 'deposit_transactions', 'contractors', 'work_orders', 'work_photos', 'expenses', 'expense_categories',
    'cash_movements', 'charge_invoices', 'charge_allocations', 'charges', 'incidents', 'inspections', 'documents',
    'message_threads', 'payment_transactions', 'reconciliation_entries', 'payment_providers',
  ];
  const lignes = await Promise.all(tables.map(async (t) => {
    const [[r]] = await sequelize.query(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) AS h FROM ${t} x WHERE owner_id = :o`, { replacements: { o: ownerId } });
    return `${t}:${r.h}`;
  }));
  const [[m]] = await sequelize.query('SELECT md5(coalesce(string_agg(m::text, \'|\' ORDER BY m.id), \'\')) AS h FROM messages m JOIN message_threads t ON t.id = m.thread_id WHERE t.owner_id = :o', { replacements: { o: ownerId } });
  const [[ii]] = await sequelize.query('SELECT md5(coalesce(string_agg(i::text, \'|\' ORDER BY i.id), \'\')) AS h FROM inspection_items i JOIN inspections s ON s.id = i.inspection_id WHERE s.owner_id = :o', { replacements: { o: ownerId } });
  return [...lignes, `messages:${m.h}`, `inspection_items:${ii.h}`].join('\n');
}

describe('Matrices de sécurité — toutes les routes', () => {
  afterAll(fermer);

  test(`la liste des routes est lue sur l'application (${ROUTES.length} routes)`, () => {
    expect(ROUTES.length).toBeGreaterThan(200);
    expect(PROTEGEES.length).toBeGreaterThan(180);
  });

  test('toute route non publique répond 401 sans jeton', async () => {
    const fautes = [];
    for (const r of PROTEGEES) {
      const res = await appeler(r.methode, avecUuid(r.chemin));
      if (res.status !== 401) fautes.push(`${r.methode} ${r.chemin} → ${res.status}`);
    }
    expect(fautes).toEqual([]);
  });

  test('jeton falsifié, expiré, refresh token utilisé comme jeton d’accès, mauvais algorithme : 401 partout', async () => {
    const p = await nouveauProprietaire();
    const secret = process.env.JWT_SECRET;
    const jetons = {
      falsifie: `${p.token.slice(0, -4)}AAAA`,
      expire: jwt.sign({ sub: p.user.id, typ: 'access', tv: 0, exp: Math.floor(Date.now() / 1000) - 60 }, secret),
      refresh: p.refreshToken,
      autreSecret: jwt.sign({ sub: p.user.id, typ: 'access', tv: 0 }, 'un-autre-secret-que-celui-du-serveur', { expiresIn: '5m' }),
      sansType: jwt.sign({ sub: p.user.id, tv: 0 }, secret, { expiresIn: '5m' }),
      aucun: 'Bearer',
    };
    const fautes = [];
    for (const r of PROTEGEES) {
      for (const [nom, j] of Object.entries(jetons)) {
        const res = await appeler(r.methode, avecUuid(r.chemin), { Authorization: nom === 'aucun' ? j : `Bearer ${j}` });
        if (res.status !== 401) fautes.push(`${nom} ${r.methode} ${r.chemin} → ${res.status}`);
      }
    }
    expect(fautes).toEqual([]);
  });

  test('accès vertical : chaque espace refuse (403) les deux autres profils', async () => {
    const { proprio, locataire } = await proprietaireEtLocataire();
    const admin = await superAdmin();
    const interdits = {
      proprietaire: [['locataire', locataire.h], ['super admin', admin.h]],
      locataire: [['propriétaire', proprio.h], ['super admin', admin.h]],
      admin: [['propriétaire', proprio.h], ['locataire', locataire.h]],
    };
    const fautes = [];
    for (const r of PROTEGEES) {
      for (const [profil, h] of interdits[espace(r.chemin)] || []) {
        const res = await appeler(r.methode, avecUuid(r.chemin), h);
        if (res.status !== 403) fautes.push(`${profil} → ${r.methode} ${r.chemin} : ${res.status}`);
      }
    }
    expect(fautes).toEqual([]);
  });

  describe('accès horizontal (IDOR) : les identifiants d’un autre compte ne donnent RIEN', () => {
    let A;
    let intrus;
    beforeAll(async () => {
      A = await jeuComplet();
      intrus = await proprietaireEtLocataire();
    }, 240000);

    test('chaque route paramétrée est couverte par la matrice', () => {
      const nonCouvertes = PROTEGEES
        .filter((r) => r.chemin.includes(':') && ['proprietaire', 'locataire', 'authentifie'].includes(espace(r.chemin)))
        .filter((r) => !resoudreParametres(r.chemin, A.ids))
        .map((r) => `${r.methode} ${r.chemin}`);
      expect(nonCouvertes).toEqual([]);
    });

    test('un autre PROPRIÉTAIRE : jamais de 2xx, jamais de 500, lectures refusées (403), aucune donnée modifiée', async () => {
      const avant = await empreinte(A.proprio.ownerId);
      const fautes = [];
      for (const r of PROTEGEES.filter((x) => x.chemin.includes(':') && ['proprietaire', 'authentifie'].includes(espace(x.chemin)))) {
        const url = resoudreParametres(r.chemin, A.ids);
        const res = await appeler(r.methode, url, intrus.proprio.h);
        const lecture = r.methode === 'GET';
        // Notifications et sessions : 404 (on ne révèle même pas l'existence).
        const attendu404 = /\/(notifications|compte\/sessions)\//.test(r.chemin);
        const ok = res.status < 500 && (res.status < 200 || res.status >= 300)
          && (!lecture || res.status === (attendu404 ? 404 : 403) || res.status === 422);
        if (!ok) fautes.push(`${r.methode} ${r.chemin} → ${res.status} ${res.body?.error?.code || ''}`);
      }
      expect(fautes).toEqual([]);
      expect(await empreinte(A.proprio.ownerId)).toBe(avant);
    }, 120000);

    test('un autre LOCATAIRE : jamais de 2xx sur les ressources du premier, aucune donnée modifiée', async () => {
      const avant = await empreinte(A.proprio.ownerId);
      const fautes = [];
      for (const r of PROTEGEES.filter((x) => x.chemin.includes(':') && ['locataire', 'authentifie'].includes(espace(x.chemin)))) {
        const url = resoudreParametres(r.chemin, A.ids);
        const res = await appeler(r.methode, url, intrus.locataire.h);
        if (res.status >= 500 || (res.status >= 200 && res.status < 300)) fautes.push(`${r.methode} ${r.chemin} → ${res.status}`);
      }
      expect(fautes).toEqual([]);
      expect(await empreinte(A.proprio.ownerId)).toBe(avant);
    }, 120000);

    test('le propriétaire LÉGITIME lit bien chacune de ses ressources (la matrice ne teste pas du vide)', async () => {
      const fautes = [];
      let lues = 0;
      for (const r of PROTEGEES.filter((x) => x.methode === 'GET' && x.chemin.includes(':') && espace(x.chemin) === 'proprietaire')) {
        const res = await appeler('GET', resoudreParametres(r.chemin, A.ids), A.proprio.h);
        // 409 : état métier (ex. aperçu d'une facture déjà répartie) — jamais un refus d'accès.
        if (![200, 409, 422].includes(res.status)) fautes.push(`${r.chemin} → ${res.status}`);
        else if (res.status === 200) lues += 1;
      }
      expect(fautes).toEqual([]);
      expect(lues).toBeGreaterThan(20);
    });
  });

  test('identifiant malformé dans l’URL : jamais de 500 ni de 2xx', async () => {
    const { proprio, locataire } = await proprietaireEtLocataire();
    const profil = { proprietaire: proprio.h, authentifie: proprio.h, locataire: locataire.h };
    const fautes = [];
    for (const r of PROTEGEES.filter((x) => x.chemin.includes(':') && profil[espace(x.chemin)])) {
      for (const valeur of ['pas-un-uuid', "1' OR '1'='1", '00000000-0000-0000-0000-000000000000']) {
        const url = r.chemin.replace(/:[A-Za-z]+/g, encodeURIComponent(valeur));
        const res = await appeler(r.methode, url, profil[espace(r.chemin)]);
        if (res.status >= 500 || (res.status >= 200 && res.status < 300)) fautes.push(`${valeur} ${r.methode} ${r.chemin} → ${res.status}`);
      }
    }
    expect(fautes).toEqual([]);
  }, 120000);

  test('aucune réponse d’erreur ne divulgue de pile, de SQL ou de secret', async () => {
    const p = await nouveauProprietaire();
    const reponses = await Promise.all([
      api().get('/api/v1/immeubles/pas-un-uuid').set(p.h),
      api().post('/api/v1/immeubles').set(p.h).set('Content-Type', 'application/json').send('{"name": '),
      api().post('/api/v1/auth/connexion').send({ identifiant: "' OR 1=1 --", password: 'x' }),
      api().get('/api/v1/route-inexistante').set(p.h),
    ]);
    for (const res of reponses) {
      const texte = JSON.stringify(res.body);
      expect(texte).not.toMatch(/SELECT|INSERT|sequelize|at \w+ \(|\.js:\d+|password_hash|JWT_SECRET/i);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toEqual(expect.any(String));
      expect(res.body.requestId).toEqual(expect.any(String));
    }
    expect(reponses.map((r) => r.status)).toEqual([422, 400, 401, 404]);
  });

  test('un compte supprimé (logiquement) perd immédiatement l’accès', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query('UPDATE users SET deleted_at = now() WHERE id = :id', { replacements: { id: p.user.id } });
    expect((await api().get('/api/v1/immeubles').set(bearer(p.token))).status).toBe(401);
  });
});
