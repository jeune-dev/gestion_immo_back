'use strict';

const { listerRoutes } = require('../../../../scripts/lister-routes.js');
const {
  api, superAdmin, proprietaireEtLocataire, creerImmeuble, fermer, sequelize,
} = require('../../setup/helpers.js');
const { jeuComplet } = require('../../setup/jeuComplet.js');

/**
 * PAGINATION, RECHERCHE, TRI et INJECTION sur toutes les listes paginées de
 * l'API (§ 37 « pagination côté backend », § 45 « écrans rapides avec
 * plusieurs milliers de données »).
 *
 * Les listes sont DÉTECTÉES : toute route GET sans paramètre dont la réponse
 * porte `data.pagination`. Une nouvelle liste est donc contrôlée d'office.
 */

const ROUTES_GET = listerRoutes()
  .filter((r) => r.methode === 'GET' && r.chemin.startsWith('/api/v1/') && !r.chemin.includes(':'))
  .map((r) => r.chemin);

const INJECTIONS = [
  "' OR '1'='1", "'; DROP TABLE buildings; --", '%', '_', '\\', '%%__\\\\', '"; SELECT pg_sleep(5); --',
  "Rés'idence « Almadiès » ç", '<script>alert(1)</script>', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢 😀', 'a'.repeat(100),
];

describe('Listes : pagination, recherche, tri, injection', () => {
  let listes;
  let profils;

  beforeAll(async () => {
    const complet = await jeuComplet();
    const autre = await proprietaireEtLocataire();
    const admin = await superAdmin();
    profils = { proprietaire: complet.proprio.h, locataire: complet.locataire.h, admin: admin.h, autre: autre.proprio.h };
    // Détection des listes paginées, chacune avec le profil qui y a accès.
    listes = [];
    for (const chemin of ROUTES_GET) {
      const h = chemin.startsWith('/api/v1/admin/') ? profils.admin
        : chemin.startsWith('/api/v1/locataire/') ? profils.locataire : profils.proprietaire;
      const res = await api().get(chemin).set(h);
      if (res.status === 200 && res.body?.data?.pagination) listes.push({ chemin, h, total: res.body.data.pagination.total });
    }
  }, 240000);

  afterAll(fermer);

  /**
   * Total ACTUEL d'une liste, mesuré juste avant la vérification : d'autres
   * tests du fichier (ordre aléatoire) ajoutent des données — 151 immeubles,
   * donc autant de lignes au journal d'audit de la plateforme.
   */
  const totalActuel = async (l) => (await api().get(l.chemin).set(l.h)).body.data.pagination.total;

  test('les listes paginées sont détectées (au moins 30)', () => {
    expect(listes.length).toBeGreaterThanOrEqual(30);
  });

  test('métadonnées exactes : page, limit, total, totalPages cohérents avec les éléments', async () => {
    const fautes = [];
    for (const l of listes) {
      const res = await api().get(`${l.chemin}?page=1&limit=2`).set(l.h);
      const { items, pagination } = res.body.data;
      const attendus = Math.min(2, pagination.total);
      if (pagination.page !== 1 || pagination.limit !== 2 || items.length !== attendus
        || pagination.totalPages !== Math.max(1, Math.ceil(pagination.total / 2))) {
        fautes.push(`${l.chemin} → ${JSON.stringify(pagination)} / ${items.length} éléments`);
      }
    }
    expect(fautes).toEqual([]);
  });

  test('page et limit invalides → 422 partout (jamais corrigées en silence)', async () => {
    const fautes = [];
    for (const l of listes) {
      for (const qs of ['page=0', 'page=-1', 'page=abc', 'page=1.5', 'limit=0', 'limit=-5', 'limit=abc', 'limit=1e3']) {
        const res = await api().get(`${l.chemin}?${qs}`).set(l.h);
        if (res.status !== 422) fautes.push(`${l.chemin}?${qs} → ${res.status}`);
      }
    }
    expect(fautes).toEqual([]);
  });

  test('limit au-delà du plafond → ramenée à 100 ; page au-delà des résultats → liste vide, total inchangé', async () => {
    const fautes = [];
    for (const l of listes) {
      const grand = await api().get(`${l.chemin}?limit=1000`).set(l.h);
      if (grand.status !== 200 || grand.body.data.pagination.limit !== 100) fautes.push(`${l.chemin} limit=1000 → ${grand.status} ${grand.body?.data?.pagination?.limit}`);
      const reference = await totalActuel(l);
      const loin = await api().get(`${l.chemin}?page=99999`).set(l.h);
      if (loin.status !== 200 || loin.body.data.items.length !== 0 || loin.body.data.pagination.total !== reference) {
        fautes.push(`${l.chemin} page=99999 → ${loin.status} ${loin.body?.data?.items?.length}`);
      }
    }
    expect(fautes).toEqual([]);
  });

  test('recherche et filtres hostiles : jamais de 500, aucune donnée détruite, aucune fuite', async () => {
    const [[avant]] = await sequelize.query('SELECT (SELECT count(*) FROM buildings)::int AS b, (SELECT count(*) FROM users)::int AS u');
    const fautes = [];
    for (const l of listes) {
      const reference = await totalActuel(l);
      for (const valeur of INJECTIONS) {
        const q = encodeURIComponent(valeur);
        const res = await api().get(`${l.chemin}?q=${q}&search=${q}&tri=${q}&status=${q}`).set(l.h);
        if (res.status >= 500) fautes.push(`${l.chemin} « ${valeur} » → ${res.status}`);
        if (res.status === 200 && res.body.data.pagination.total > reference) fautes.push(`${l.chemin} « ${valeur} » élargit le résultat`);
      }
    }
    const [[apres]] = await sequelize.query('SELECT (SELECT count(*) FROM buildings)::int AS b, (SELECT count(*) FROM users)::int AS u');
    expect(fautes).toEqual([]);
    expect(apres).toEqual(avant);
  }, 120000);

  test('filtres de date : une date au bon format mais inexistante (2026-02-30) → 422, jamais 500 PostgreSQL', async () => {
    const fautes = [];
    let filtrees = 0;
    for (const l of listes) {
      for (const champ of ['du', 'au']) {
        // Filtre réellement VALIDÉ par cette liste : date valide 200, texte 422
        // (une liste qui ignore le paramètre répond 200 dans les deux cas).
        const valide = (await api().get(`${l.chemin}?${champ}=2026-02-01`).set(l.h)).status;
        const texte = (await api().get(`${l.chemin}?${champ}=abc`).set(l.h)).status;
        const utilise = valide === 200 && texte === 422;
        if (utilise) filtrees += 1;
        for (const date of ['2026-02-30', '2026-04-31', '2027-02-29']) {
          const res = await api().get(`${l.chemin}?${champ}=${date}`).set(l.h);
          if (res.status >= 500 || (utilise && res.status !== 422)) fautes.push(`${l.chemin}?${champ}=${date} → ${res.status}`);
        }
      }
    }
    expect(filtrees).toBeGreaterThan(5);
    expect(fautes).toEqual([]);
  }, 120000);

  test('tri : une colonne hors liste blanche est refusée (422), jamais injectée dans ORDER BY', async () => {
    const fautes = [];
    for (const l of listes) {
      const res = await api().get(`${l.chemin}?tri=${encodeURIComponent('password_hash')}`).set(l.h);
      if (![200, 422].includes(res.status)) fautes.push(`${l.chemin} → ${res.status}`);
      const sql = await api().get(`${l.chemin}?tri=${encodeURIComponent('id; DROP TABLE users')}`).set(l.h);
      if (![200, 422].includes(sql.status)) fautes.push(`${l.chemin} (injection) → ${sql.status}`);
    }
    expect(fautes).toEqual([]);
  });

  test('isolation : un autre propriétaire ne voit AUCUN élément du premier dans ses listes', async () => {
    const fautes = [];
    for (const l of listes.filter((x) => x.h === profils.proprietaire)) {
      const res = await api().get(`${l.chemin}?limit=100`).set(profils.autre);
      const [mienne, sienne] = [await api().get(`${l.chemin}?limit=100`).set(l.h), res];
      const ids = new Set((mienne.body.data?.items || []).map((i) => i.id).filter(Boolean));
      const communs = (sienne.body.data?.items || []).filter((i) => i.id && ids.has(i.id)
        && !l.chemin.startsWith('/api/v1/categories-depenses')); // catégories globales partagées par conception
      if (communs.length) fautes.push(`${l.chemin} : ${communs.length} élément(s) partagé(s)`);
    }
    expect(fautes).toEqual([]);
  });

  test('volume : 150 immeubles → pages disjointes, total exact, et la base ne renvoie que la page demandée (LIMIT/OFFSET)', async () => {
    const { proprio } = await proprietaireEtLocataire();
    await sequelize.query("UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = 'PRO') WHERE owner_id = :o", { replacements: { o: proprio.ownerId } });
    await require('../../../modules/abonnement/service/droits.service.js').invalider(proprio.ownerId);
    await sequelize.query(
      `INSERT INTO buildings (owner_id, name, address, city)
       SELECT :o, 'Immeuble ' || lpad(g::text, 3, '0'), 'Adresse', 'Dakar' FROM generate_series(1, 149) g`,
      { replacements: { o: proprio.ownerId } }
    );
    await creerImmeuble(proprio, { name: 'Zzz dernier' });

    // Espion SQL : l'option `logging` de Sequelize reçoit le texte exact de chaque requête.
    const requetes = [];
    const journalOrigine = sequelize.options.logging;
    sequelize.options.logging = (sql) => requetes.push(String(sql));
    const p1 = await api().get('/api/v1/immeubles?page=1&limit=10&tri=name').set(proprio.h);
    const p2 = await api().get('/api/v1/immeubles?page=2&limit=10&tri=name').set(proprio.h);
    const dernier = await api().get('/api/v1/immeubles?page=15&limit=10&tri=name').set(proprio.h);
    sequelize.options.logging = journalOrigine;

    expect(p1.body.data.pagination).toEqual({ page: 1, limit: 10, total: 151, totalPages: 16 });
    expect(p1.body.data.items).toHaveLength(10);
    const ids1 = new Set(p1.body.data.items.map((b) => b.id));
    expect(p2.body.data.items.some((b) => ids1.has(b.id))).toBe(false);
    expect(dernier.body.data.items.length).toBe(10);
    const selects = requetes.filter((q) => /FROM "buildings"/.test(q) && !/SELECT count\(\*\) AS "count"/.test(q));
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((q) => /LIMIT 10/.test(q))).toBe(true);
    expect(selects.some((q) => /OFFSET 10/.test(q))).toBe(true);
  });
});
