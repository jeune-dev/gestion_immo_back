'use strict';

const {
  api, nouveauProprietaire, superAdmin, proprietaireEtLocataire, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const { notifier } = require('../../../../modules/notification/service/notification.service.js');
const {
  UUID_INCONNU, jetonsDegrades, verifierMatrice, verifierStatuts, proprietaireSansPermission,
} = require('../baux/securite.outils.js');

/**
 * Notifications internes (§ 27) — les 4 routes pour chaque type de compte :
 * portée stricte au compte (`user_id`) — la notification d'autrui répond 404
 * et reste intacte —, filtre, pagination, compteur, lecture groupée,
 * authentification et concurrence.
 */

const BASE = '/api/v1/notifications';

async function emettre(userId, ownerId, n, prefixe = 'Avis') {
  for (let i = 1; i <= n; i += 1) {
    await notifier(null, {
      destinataires: [{ userId }], ownerId, type: 'echeance', titre: `${prefixe} ${i}`, corps: `Corps ${i}`, donnees: { rang: i },
    });
  }
}

const idsDe = async (h, q = '') => (await api().get(`${BASE}${q}`).set(h)).body.data.items.map((n) => n.id);

describe('Notifications — API complète (§ 27)', () => {
  afterAll(fermer);

  test('chaque type de compte (propriétaire, locataire, super admin) ne voit que SES notifications', async () => {
    const { proprio: p, locataire } = await proprietaireEtLocataire();
    const admin = await superAdmin();
    await sequelize.query('DELETE FROM notifications WHERE user_id IN (:u)', { replacements: { u: [p.user.id, locataire.user.id] } });
    await emettre(p.user.id, p.ownerId, 2, 'Propriétaire');
    await emettre(locataire.user.id, p.ownerId, 3, 'Locataire');
    await emettre(admin.user.id, null, 1, 'Admin');
    for (const [h, titres] of [[p.h, ['Propriétaire 2', 'Propriétaire 1']], [locataire.h, ['Locataire 3', 'Locataire 2', 'Locataire 1']], [admin.h, ['Admin 1']]]) {
      const res = await api().get(BASE).set(h);
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((n) => n.title)).toEqual(titres);
      expect(Object.keys(res.body.data.items[0]).sort()).toEqual(['body', 'created_at', 'data', 'id', 'read_at', 'title', 'type']);
      expect((await api().get(`${BASE}/compteur`).set(h)).body.data.non_lues).toBe(titres.length);
    }
  });

  test('liste vide ; pagination (pages, au-delà, plafond) ; filtre non_lues ; paramètres invalides 422', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query('DELETE FROM notifications WHERE user_id = :u', { replacements: { u: p.user.id } });
    expect((await api().get(BASE).set(p.h)).body.data).toEqual({ items: [], pagination: expect.objectContaining({ total: 0 }) });
    expect((await api().get(`${BASE}/compteur`).set(p.h)).body.data.non_lues).toBe(0);
    await emettre(p.user.id, p.ownerId, 5);
    const p2 = await api().get(`${BASE}?limit=2&page=2`).set(p.h);
    expect(p2.body.data.items.map((n) => n.title)).toEqual(['Avis 3', 'Avis 2']);
    expect(p2.body.data.pagination).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3 });
    expect(await idsDe(p.h, '?limit=2&page=4')).toEqual([]);
    expect((await api().get(`${BASE}?limit=1000`).set(p.h)).body.data.pagination.limit).toBe(100);
    const [premiere] = await idsDe(p.h);
    await api().post(`${BASE}/${premiere}/lue`).set(p.h);
    const nonLues = await api().get(`${BASE}?non_lues=true`).set(p.h);
    expect(nonLues.body.data.pagination.total).toBe(4);
    expect(nonLues.body.data.items.map((n) => n.id)).not.toContain(premiere);
    expect((await api().get(`${BASE}?non_lues=false`).set(p.h)).body.data.pagination.total).toBe(5);
    const ecarts = await verifierStatuts([
      ['get', `${BASE}?page=0`, undefined, 422],
      ['get', `${BASE}?page=-1`, undefined, 422],
      ['get', `${BASE}?limit=0`, undefined, 422],
      ['get', `${BASE}?limit=abc`, undefined, 422],
      ['get', `${BASE}?non_lues=peut-etre`, undefined, 422],
    ], p.h);
    expect(ecarts).toEqual([]);
  });

  test('POST /:id/lue : la notification d’un autre compte → 404 et reste non lue ; identifiant invalide 422, inconnu 404', async () => {
    const a = await nouveauProprietaire();
    const { locataire } = await proprietaireEtLocataire();
    await emettre(locataire.user.id, null, 1, 'Privée');
    const [privee] = await idsDe(locataire.h);
    for (const h of [a.h, (await superAdmin()).h]) {
      const res = await api().post(`${BASE}/${privee}/lue`).set(h);
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('data.notification');
    }
    const [[ligne]] = await sequelize.query('SELECT read_at FROM notifications WHERE id = :id', { replacements: { id: privee } });
    expect(ligne.read_at).toBeNull();
    expect(await verifierStatuts([
      ['post', `${BASE}/abc/lue`, undefined, 422],
      ['post', `${BASE}/${UUID_INCONNU}/lue`, undefined, 404],
    ], a.h)).toEqual([]);
    const lue = await api().post(`${BASE}/${privee}/lue`).set(locataire.h);
    expect(lue.status).toBe(200);
    expect(lue.body.data.notification).toMatchObject({ id: privee, title: 'Privée 1' });
    expect(lue.body.data.notification.read_at).not.toBeNull();
  });

  test('tout-lire : ne touche que MES notifications, renvoie leur nombre, puis 0', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    await sequelize.query('DELETE FROM notifications WHERE user_id IN (:u)', { replacements: { u: [a.user.id, b.user.id] } });
    await emettre(a.user.id, a.ownerId, 3);
    await emettre(b.user.id, b.ownerId, 2);
    const res = await api().post(`${BASE}/tout-lire`).set(a.h);
    expect(res.status).toBe(200);
    expect(res.body.data.marquees).toBe(3);
    expect((await api().post(`${BASE}/tout-lire`).set(a.h)).body.data.marquees).toBe(0);
    expect(await compter('notifications', 'user_id = :u AND read_at IS NULL', { u: b.user.id })).toBe(2);
    expect((await api().get(`${BASE}/compteur`).set(a.h)).body.data.non_lues).toBe(0);
  });

  test('concurrence : tout-lire lancé deux fois en même temps marque chaque notification une seule fois', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query('DELETE FROM notifications WHERE user_id = :u', { replacements: { u: p.user.id } });
    await emettre(p.user.id, p.ownerId, 6);
    const reponses = await Promise.all([1, 2].map(() => api().post(`${BASE}/tout-lire`).set(p.h)));
    expect(reponses.map((r) => r.status)).toEqual([200, 200]);
    expect(reponses.reduce((s, r) => s + r.body.data.marquees, 0)).toBe(6);
    expect(await compter('notifications', 'user_id = :u AND read_at IS NULL', { u: p.user.id })).toBe(0);
  });

  test('authentification refusée sur les 4 routes (401 ; 403 compte désactivé) ; aucune permission requise pour SES notifications', async () => {
    const routes = [['get', BASE], ['get', `${BASE}/compteur`], ['post', `${BASE}/tout-lire`], ['post', `${BASE}/${UUID_INCONNU}/lue`]];
    expect(await verifierMatrice(routes, await jetonsDegrades('proprietaire'))).toEqual([]);
    expect(await verifierMatrice(routes, await jetonsDegrades('locataire'))).toEqual([]);
    const sansDroit = await proprietaireSansPermission();
    expect(await verifierStatuts([
      ['get', BASE, undefined, 200], ['get', `${BASE}/compteur`, undefined, 200], ['post', `${BASE}/tout-lire`, undefined, 200],
    ], sansDroit.h)).toEqual([]);
  });
});
