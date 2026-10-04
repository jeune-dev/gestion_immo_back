'use strict';

const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const {
  api, nouveauProprietaire, bailActif, activerLocataire, creerLocataire, fermer, sequelize,
} = require('../../../setup/helpers.js');
const auth = require('../../../../middlewares/auth.middleware.js');
const { requireLocataire } = require('../../../../middlewares/acces.middleware.js');
const errorHandler = require('../../../../middlewares/errorHandler.middleware.js');
const { historiquePourLocataire } = require('../../../../modules/messagerie/service/messagerie.service.js');

/**
 * § 54.1 Messagerie intégrée : un fil par locataire visible des deux parties
 * seulement (§ 56.2), texte et photo, état envoyé / lu, rattachement à une
 * ressource du même propriétaire, notification à chaque message.
 */

// L'espace locataire est monté par routes.js ailleurs : le routeur locataire
// est monté ici sur une application minimale, derrière les mêmes gardes.
const appLocataire = express();
appLocataire.use(require('../../../../middlewares/requestId.middleware.js'));
appLocataire.use(express.json());
appLocataire.use('/api/v1/locataire/messagerie', auth, requireLocataire, require('../../../../modules/messagerie/route/messagerieLocataire.route.js'));
appLocataire.use(errorHandler);
const loc = () => request(appLocataire);

const BASE = '/api/v1/messagerie';
const BASE_LOC = '/api/v1/locataire/messagerie';

async function incident(proprio, buildingId, tenantId) {
  const [[ligne]] = await sequelize.query(
    `INSERT INTO incidents (owner_id, tenant_id, building_id, reference, category, title, description, reported_by)
     VALUES (:ownerId, :tenantId, :buildingId, :reference, 'fuite', 'Fuite cuisine', 'Fuite sous l''évier', :userId)
     RETURNING id`,
    {
      replacements: {
        ownerId: proprio.ownerId, tenantId, buildingId, userId: proprio.user.id, reference: `INC-${Math.random().toString(36).slice(2, 10)}`,
      },
    }
  );
  return ligne.id;
}

async function echeanceDe(tenantId) {
  const [[ligne]] = await sequelize.query('SELECT id FROM rent_schedules WHERE tenant_id = :tenantId ORDER BY due_date LIMIT 1', { replacements: { tenantId } });
  return ligne.id;
}

/**
 * Prépare, PAR L'API, un propriétaire A dédié avec un bail actif et le compte
 * locataire activé ; avec `messages`, le propriétaire ouvre le fil par deux
 * messages (« Bonjour… » puis « Merci… »). Chaque test a ainsi son propre fil
 * et ses compteurs exacts, quel que soit l'ordre d'exécution.
 */
async function preparerFil({ messages = true } = {}) {
  const A = await nouveauProprietaire();
  const bailA = await bailActif(A);
  const locA = await activerLocataire(A, bailA.tenant);
  let filA = null;
  if (messages) {
    for (const body of ['Bonjour, le plombier passe demain.', 'Merci de laisser la clé.']) {
      const res = await api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(A.h).send({ body });
      if (res.status !== 201) throw new Error(`Message : ${res.status} ${JSON.stringify(res.body)}`);
      filA = res.body.data.message.thread_id;
    }
  }
  return { A, bailA, locA, filA };
}

describe('Messagerie (§ 54.1)', () => {
  // B et son locataire : LECTURE SEULE (ils ne font que des tentatives refusées).
  let B; let bailB; let locB;
  let png;

  beforeAll(async () => {
    png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).png().toBuffer();
    B = await nouveauProprietaire();
    bailB = await bailActif(B);
    locB = await activerLocataire(B, bailB.tenant);
  });

  afterAll(fermer);

  test('le propriétaire écrit : fil créé, message « envoyé », locataire notifié', async () => {
    const { A, bailA, locA } = await preparerFil({ messages: false });
    const res = await api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(A.h).send({ body: 'Bonjour, le plombier passe demain.' });
    expect(res.status).toBe(201);
    expect(res.body.data.message).toMatchObject({ sender_role: 'proprietaire', status: 'envoye', body: 'Bonjour, le plombier passe demain.' });
    const filA = res.body.data.message.thread_id;

    const second = await api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(A.h).send({ body: 'Merci de laisser la clé.' });
    expect(second.body.data.message.thread_id).toBe(filA);

    const [[{ n }]] = await sequelize.query(
      "SELECT count(*)::int AS n FROM notifications WHERE user_id = :u AND type = 'nouveau_message'",
      { replacements: { u: locA.user.id } }
    );
    expect(n).toBe(2);
  });

  test('le locataire voit son fil, ses non-lus, puis accuse lecture (état lu)', async () => {
    const { A, locA, filA } = await preparerFil();
    const fils = await loc().get(BASE_LOC).set(locA.h);
    expect(fils.status).toBe(200);
    expect(fils.body.data.items).toHaveLength(1);
    const fil = fils.body.data.items[0];
    expect(fil.id).toBe(filA);
    expect(fil.unread_count).toBe(2);
    expect(fil.owner.display_name).toBeTruthy();
    expect(fil.last_message.preview).toBe('Merci de laisser la clé.');

    const messages = await loc().get(`${BASE_LOC}/${filA}/messages`).set(locA.h);
    expect(messages.status).toBe(200);
    expect(messages.body.data.items.map((m) => m.body)).toEqual(['Merci de laisser la clé.', 'Bonjour, le plombier passe demain.']);

    const lu = await loc().post(`${BASE_LOC}/${filA}/lu`).set(locA.h);
    expect(lu.status).toBe(200);
    expect(lu.body.data.marques).toBe(2);

    const vuParProprio = await api().get(`${BASE}/fils/${filA}/messages`).set(A.h);
    expect(vuParProprio.body.data.items.every((m) => m.status === 'lu')).toBe(true);
    const apres = await loc().get(BASE_LOC).set(locA.h);
    expect(apres.body.data.items[0].unread_count).toBe(0);
  });

  test('le locataire répond : compteur de non-lus du propriétaire, puis lecture', async () => {
    const {
      A, bailA, locA, filA,
    } = await preparerFil();
    const res = await loc().post(`${BASE_LOC}/${filA}/messages`).set(locA.h).send({ body: 'Entendu, je serai là.' });
    expect(res.status).toBe(201);
    expect(res.body.data.message.sender_role).toBe('locataire');

    const [[{ n }]] = await sequelize.query(
      "SELECT count(*)::int AS n FROM notifications WHERE user_id = :u AND type = 'nouveau_message'",
      { replacements: { u: A.user.id } }
    );
    expect(n).toBe(1);

    const fils = await api().get(`${BASE}/fils`).set(A.h);
    expect(fils.status).toBe(200);
    expect(fils.body.data.pagination.total).toBe(1);
    const fil = fils.body.data.items[0];
    expect(fil.tenant).toMatchObject({ id: bailA.tenant.id, first_name: bailA.tenant.first_name });
    expect(fil.unread_count).toBe(1);
    expect(fil.last_message).toMatchObject({ sender_role: 'locataire', preview: 'Entendu, je serai là.', status: 'envoye' });

    const lu = await api().post(`${BASE}/fils/${filA}/lu`).set(A.h);
    expect(lu.body.data.marques).toBe(1);
    const apres = await api().get(`${BASE}/fils`).set(A.h);
    expect(apres.body.data.items[0].unread_count).toBe(0);
    expect(apres.body.data.items[0].last_message.status).toBe('lu');
  });

  test('isolation : un autre locataire ou un autre propriétaire → 403 (§ 56.2)', async () => {
    const {
      A, bailA, locA, filA,
    } = await preparerFil();
    expect((await loc().get(`${BASE_LOC}/${filA}/messages`).set(locB.h)).status).toBe(403);
    expect((await loc().post(`${BASE_LOC}/${filA}/messages`).set(locB.h).send({ body: 'Intrusion' })).status).toBe(403);
    expect((await loc().post(`${BASE_LOC}/${filA}/lu`).set(locB.h)).status).toBe(403);
    expect((await api().get(`${BASE}/fils/${filA}/messages`).set(B.h)).status).toBe(403);
    expect((await api().post(`${BASE}/fils/${filA}/lu`).set(B.h)).status).toBe(403);
    expect((await api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(B.h).send({ body: 'Intrusion' })).status).toBe(403);

    // Le locataire B ne voit que SON fil ; le propriétaire B n'a aucun fil actif.
    const filsB = await loc().get(BASE_LOC).set(locB.h);
    expect(filsB.body.data.items.map((f) => f.id)).not.toContain(filA);
    expect((await api().get(`${BASE}/fils`).set(B.h)).body.data.items).toHaveLength(0);

    // Un propriétaire n'utilise pas l'espace locataire, et inversement.
    expect((await loc().get(BASE_LOC).set(A.h)).status).toBe(403);
    expect((await api().get(`${BASE}/fils`).set(locA.h)).status).toBe(403);

    const inconnu = '6f1c1d52-8d4b-4c8e-9a51-2f3c2b0d9e11';
    expect((await api().get(`${BASE}/fils/${inconnu}/messages`).set(A.h)).status).toBe(404);
    expect((await loc().get(`${BASE_LOC}/${inconnu}/messages`).set(locA.h)).status).toBe(404);
  });

  test('message photo : miniature, document partagé lisible par les deux parties seulement', async () => {
    const {
      A, bailA, locA, filA,
    } = await preparerFil();
    const res = await api().post(`${BASE}/locataires/${bailA.tenant.id}/photos`).set(A.h)
      .field('body', 'Photo du compteur').attach('fichier', png, 'compteur.png');
    expect(res.status).toBe(201);
    const { document } = res.body.data.message;
    expect(document).toMatchObject({ category: 'photo', mime_type: 'image/png', has_thumbnail: true, visible_to_tenant: true });

    const parLocataire = await api().get(`/api/v1/documents/${document.id}/fichier`).set(locA.h);
    expect(parLocataire.status).toBe(200);
    expect(parLocataire.headers['content-type']).toBe('image/png');
    const miniature = await api().get(`/api/v1/documents/${document.id}/fichier?taille=miniature`).set(locA.h);
    expect(miniature.headers['content-type']).toBe('image/webp');

    expect((await api().get(`/api/v1/documents/${document.id}/fichier`).set(locB.h)).status).toBe(403);
    expect((await api().get(`/api/v1/documents/${document.id}/fichier`).set(B.h)).status).toBe(403);

    // Photo du locataire, sans légende.
    const photoLoc = await loc().post(`${BASE_LOC}/${filA}/photos`).set(locA.h).attach('fichier', png, 'fuite.png');
    expect(photoLoc.status).toBe(201);
    expect(photoLoc.body.data.message.body).toBeNull();
    const parProprio = await api().get(`/api/v1/documents/${photoLoc.body.data.message.document.id}/fichier`).set(A.h);
    expect(parProprio.status).toBe(200);

    // Une pièce de conversation fait partie de l'historique : non supprimable.
    const suppression = await api().delete(`/api/v1/documents/${document.id}`).set(A.h);
    expect(suppression.status).toBe(409);
    expect(suppression.body.error.code).toBe('DOCUMENT_PROTEGE');

    // Un PDF n'est pas une photo.
    const pdf = await api().post(`${BASE}/locataires/${bailA.tenant.id}/photos`).set(A.h)
      .attach('fichier', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'), 'x.pdf');
    expect(pdf.status).toBe(400);
  });

  test('rattachement : ressource du même propriétaire et concernant le locataire', async () => {
    const {
      A, bailA, locA, filA,
    } = await preparerFil();
    const echeanceA = await echeanceDe(bailA.tenant.id);
    const echeanceB = await echeanceDe(bailB.tenant.id);

    const ok = await api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(A.h)
      .send({ body: 'Rappel de loyer', related_type: 'rent_schedule', related_id: echeanceA });
    expect(ok.status).toBe(201);
    expect(ok.body.data.message).toMatchObject({ related_type: 'rent_schedule', related_id: echeanceA });

    // Ressource d'un autre propriétaire → 403 ; inexistante → 422 ; incomplète → 422.
    expect((await api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(A.h)
      .send({ body: 'x', related_type: 'rent_schedule', related_id: echeanceB })).status).toBe(403);
    expect((await loc().post(`${BASE_LOC}/${filA}/messages`).set(locA.h)
      .send({ body: 'x', related_type: 'rent_schedule', related_id: echeanceB })).status).toBe(403);
    expect((await api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(A.h)
      .send({ body: 'x', related_type: 'incident', related_id: '6f1c1d52-8d4b-4c8e-9a51-2f3c2b0d9e11' })).status).toBe(422);
    expect((await api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(A.h)
      .send({ body: 'x', related_type: 'incident' })).status).toBe(422);

    // Le locataire ne peut rattacher que ce qui le concerne.
    const voisin = await creerLocataire(A);
    const incidentVoisin = await incident(A, bailA.building.id, voisin.id);
    const incidentA = await incident(A, bailA.building.id, bailA.tenant.id);
    const refus = await loc().post(`${BASE_LOC}/${filA}/messages`).set(locA.h)
      .send({ body: 'x', related_type: 'incident', related_id: incidentVoisin });
    expect(refus.status).toBe(403);
    expect(refus.body.error.code).toBe('RATTACHEMENT_REFUSE');
    expect((await loc().post(`${BASE_LOC}/${filA}/messages`).set(locA.h)
      .send({ body: 'Des nouvelles ?', related_type: 'incident', related_id: incidentA })).status).toBe(201);
    expect((await loc().post(`${BASE_LOC}/${filA}/messages`).set(locA.h)
      .send({ body: 'Mon loyer', related_type: 'rent_schedule', related_id: echeanceA })).status).toBe(201);
  });

  test('validation : corps vide ou trop long refusé (422)', async () => {
    const {
      A, bailA, locA, filA,
    } = await preparerFil();
    expect((await api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(A.h).send({ body: '   ' })).status).toBe(422);
    expect((await api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(A.h).send({ body: 'a'.repeat(4001) })).status).toBe(422);
    expect((await loc().post(`${BASE_LOC}/${filA}/messages`).set(locA.h).send({})).status).toBe(422);
    expect((await api().post(`${BASE}/locataires/pas-un-uuid/messages`).set(A.h).send({ body: 'x' })).status).toBe(422);
  });

  test('historique pour le dossier locataire (§ 54.1)', async () => {
    // Conversation complète construite par l'API : 2 messages du propriétaire
    // (préparation), une réponse, deux photos et deux messages rattachés.
    const {
      A, bailA, locA, filA,
    } = await preparerFil();
    const echeanceA = await echeanceDe(bailA.tenant.id);
    const envois = [
      () => loc().post(`${BASE_LOC}/${filA}/messages`).set(locA.h).send({ body: 'Entendu, je serai là.' }),
      () => api().post(`${BASE}/locataires/${bailA.tenant.id}/photos`).set(A.h).field('body', 'Photo du compteur').attach('fichier', png, 'compteur.png'),
      () => loc().post(`${BASE_LOC}/${filA}/photos`).set(locA.h).attach('fichier', png, 'fuite.png'),
      () => api().post(`${BASE}/locataires/${bailA.tenant.id}/messages`).set(A.h).send({ body: 'Rappel de loyer', related_type: 'rent_schedule', related_id: echeanceA }),
      () => loc().post(`${BASE_LOC}/${filA}/messages`).set(locA.h).send({ body: 'Mon loyer', related_type: 'rent_schedule', related_id: echeanceA }),
    ];
    // Envois successifs (dates de création croissantes, comme une vraie conversation).
    for (const envoi of envois) expect((await envoi()).status).toBe(201);

    const { rows, count } = await historiquePourLocataire(A.ownerId, bailA.tenant.id, { limit: 50, offset: 0 });
    expect(count).toBeGreaterThanOrEqual(7);
    expect(rows).toHaveLength(count);
    expect(new Date(rows[0].created_at).getTime()).toBeGreaterThanOrEqual(new Date(rows[rows.length - 1].created_at).getTime());
    const vide = await historiquePourLocataire(B.ownerId, bailA.tenant.id, { limit: 50, offset: 0 });
    expect(vide).toEqual({ rows: [], count: 0 });
  });
});
