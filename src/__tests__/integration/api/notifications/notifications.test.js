'use strict';

const {
  api, nouveauProprietaire, superAdmin, bailActif, activerLocataire, fermer,
} = require('../../../setup/helpers.js');
const { notifier } = require('../../../../modules/notification/service/notification.service.js');

/**
 * § 27 Notifications internes : liste (plus récentes d'abord, filtre non
 * lues), compteur, lecture unitaire limitée à SES notifications (une
 * notification d'autrui répond 404, sans rien révéler), tout marquer lu.
 */

const BASE = '/api/v1/notifications';

/** Notifications réelles, émises par le service (sans canal externe configuré en test). */
async function emettre(destinataire, ownerId, n) {
  for (let i = 1; i <= n; i += 1) {
    await notifier(null, {
      destinataires: [{ userId: destinataire.user.id }],
      ownerId,
      type: 'echeance',
      titre: `Échéance ${i}`,
      corps: `Votre loyer ${i} arrive à échéance.`,
      donnees: { rang: i },
    });
  }
}

describe('Notifications (§ 27)', () => {
  let A; let B;

  // Données NEUVES pour chaque test : l'ordre des tests est aléatoire
  // (`--randomize`) et plusieurs tests marquent des notifications comme lues.
  beforeEach(async () => {
    A = await nouveauProprietaire();
    B = await nouveauProprietaire();
    await emettre(A, A.ownerId, 3);
    await emettre(B, B.ownerId, 1);
  });

  afterAll(fermer);

  test('liste : les miennes seulement, plus récentes d\'abord, paginées', async () => {
    const res = await api().get(`${BASE}?limit=2`).set(A.h);
    expect(res.status).toBe(200);
    expect(res.body.data.pagination).toMatchObject({ total: 3, limit: 2, totalPages: 2 });
    expect(res.body.data.items.map((n) => n.title)).toEqual(['Échéance 3', 'Échéance 2']);
    expect(res.body.data.items[0]).toMatchObject({ type: 'echeance', read_at: null, data: { rang: 3 } });
    expect(res.body.data.items[0]).not.toHaveProperty('user_id');
  });

  test('compteur, lecture unitaire et filtre non lues', async () => {
    expect((await api().get(`${BASE}/compteur`).set(A.h)).body.data.non_lues).toBe(3);
    const [plusRecente] = (await api().get(BASE).set(A.h)).body.data.items;

    const lue = await api().post(`${BASE}/${plusRecente.id}/lue`).set(A.h);
    expect(lue.status).toBe(200);
    expect(lue.body.data.notification.read_at).not.toBeNull();
    // Idempotent : relire ne change pas la date de lecture.
    const relue = await api().post(`${BASE}/${plusRecente.id}/lue`).set(A.h);
    expect(relue.body.data.notification.read_at).toBe(lue.body.data.notification.read_at);

    expect((await api().get(`${BASE}/compteur`).set(A.h)).body.data.non_lues).toBe(2);
    const nonLues = await api().get(`${BASE}?non_lues=true`).set(A.h);
    expect(nonLues.body.data.items.map((n) => n.id)).not.toContain(plusRecente.id);
    expect(nonLues.body.data.pagination.total).toBe(2);
  });

  test('notification d\'un autre utilisateur → 404, et elle reste non lue', async () => {
    const [deB] = (await api().get(BASE).set(B.h)).body.data.items;
    const res = await api().post(`${BASE}/${deB.id}/lue`).set(A.h);
    expect(res.status).toBe(404);
    expect((await api().get(`${BASE}/compteur`).set(B.h)).body.data.non_lues).toBe(1);
    expect((await api().post(`${BASE}/6f1c1d52-8d4b-4c8e-9a51-2f3c2b0d9e11/lue`).set(A.h)).status).toBe(404);
    expect((await api().post(`${BASE}/pas-un-uuid/lue`).set(A.h)).status).toBe(422);
  });

  test('tout marquer comme lu : seules les non lues sont comptées', async () => {
    const [dejaLue] = (await api().get(BASE).set(A.h)).body.data.items;
    expect((await api().post(`${BASE}/${dejaLue.id}/lue`).set(A.h)).status).toBe(200);
    const res = await api().post(`${BASE}/tout-lire`).set(A.h);
    expect(res.status).toBe(200);
    expect(res.body.data.marquees).toBe(2);
    expect((await api().get(`${BASE}/compteur`).set(A.h)).body.data.non_lues).toBe(0);
    expect((await api().get(`${BASE}/compteur`).set(B.h)).body.data.non_lues).toBe(1);
  });

  test('locataire et super admin consultent les leurs ; sans jeton → 401', async () => {
    const { tenant } = await bailActif(B);
    const loc = await activerLocataire(B, tenant);
    await emettre(loc, B.ownerId, 2);
    const res = await api().get(BASE).set(loc.h);
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.total).toBe(2);
    expect((await api().get(`${BASE}/compteur`).set(loc.h)).body.data.non_lues).toBe(2);

    const admin = await superAdmin();
    const vide = await api().get(BASE).set(admin.h);
    expect(vide.status).toBe(200);
    expect(vide.body.data.items).toHaveLength(0);

    expect((await api().get(BASE)).status).toBe(401);
  });
});
