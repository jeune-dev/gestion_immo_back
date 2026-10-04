'use strict';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, creerLocataire, bailActif, activerLocataire, fermer, sequelize,
} = require('../../../setup/helpers.js');
const requestId = require('../../../../middlewares/requestId.middleware.js');
const auth = require('../../../../middlewares/auth.middleware.js');
const { requireLocataire } = require('../../../../middlewares/acces.middleware.js');
const errorHandler = require('../../../../middlewares/errorHandler.middleware.js');
const routesLocataire = require('../../../../modules/incident/route/incidentLocataire.route.js');

/**
 * § 22 Incidents locataires, § 23 workflow complet (signalement → analyse →
 * travaux → clôture ⇒ incident résolu), § 28 « le locataire ne voit jamais
 * les informations des autres locataires ».
 *
 * Le routeur locataire est monté ici derrière la MÊME garde que l'espace
 * locataire de routes.js (auth → requireLocataire), indépendamment de son
 * montage final sous /api/v1/locataire/incidents.
 */
const appLocataire = express();
appLocataire.use(requestId);
appLocataire.use(express.json());
appLocataire.use('/api/v1/locataire/incidents', auth, requireLocataire, routesLocataire);
appLocataire.use(errorHandler);
const loc = () => request(appLocataire);
const URL_LOC = '/api/v1/locataire/incidents';

describe('Incidents', () => {
  let a;
  let b;
  let bail;
  let locA;
  let bailAutre;
  let locAutre;
  let png;

  const notifications = async (userId, type) => {
    const [lignes] = await sequelize.query('SELECT type, title, data FROM notifications WHERE user_id = :u AND type = :type ORDER BY created_at', { replacements: { u: userId, type } });
    return lignes;
  };
  const signaler = (session, surcharges = {}) => loc().post(URL_LOC).set(session.h)
    .send({ category: 'fuite', title: 'Fuite salle de bain', description: 'De l’eau coule sous le lavabo', ...surcharges });

  beforeAll(async () => {
    a = await nouveauProprietaire();
    b = await nouveauProprietaire();
    bail = await bailActif(a);
    locA = await activerLocataire(a, bail.tenant);
    // Un autre locataire du MÊME propriétaire.
    bailAutre = await bailActif(a);
    locAutre = await activerLocataire(a, bailAutre.tenant);
    png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).png().toBuffer();
  });
  afterAll(fermer);

  test('signalement par le locataire : référence INC, logement déduit du bail, propriétaire notifié', async () => {
    const res = await signaler(locA);
    expect(res.status).toBe(201);
    const inc = res.body.data.incident;
    expect(inc.reference).toMatch(/^INC-\d{4}-\d{5}$/);
    expect(inc).toMatchObject({
      status: 'signale', tenant_id: bail.tenant.id, lease_id: bail.lease.id, apartment_id: bail.apartment.id, building_id: bail.building.id,
    });
    expect(inc).not.toHaveProperty('owner_note');
    expect(inc).not.toHaveProperty('owner_id');
    const notifs = await notifications(a.user.id, 'incident');
    expect(notifs.some((n) => n.data.incident_id === inc.id)).toBe(true);
  });

  test('validation et bail : 422 si champs invalides, bail d’autrui, ou aucune location active', async () => {
    expect((await signaler(locA, { category: 'inondation' })).status).toBe(422);
    expect((await signaler(locA, { title: undefined })).status).toBe(422);
    const autreBail = await signaler(locA, { lease_id: bailAutre.lease.id });
    expect(autreBail.status).toBe(422);
    expect(autreBail.body.error.code).toBe('BAIL_INVALIDE');

    const sansBail = await creerLocataire(a);
    const session = await activerLocataire(a, sansBail);
    const res = await signaler(session);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AUCUN_BAIL_ACTIF');
  });

  test('synchronisation hors ligne : même client_reference → même demande (200)', async () => {
    const ref = `inc-${crypto.randomBytes(6).toString('hex')}`;
    const r1 = await signaler(locA, { client_reference: ref });
    const r2 = await signaler(locA, { client_reference: ref });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.data.incident.id).toBe(r1.body.data.incident.id);
    const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM incidents WHERE client_reference = :ref', { replacements: { ref } });
    expect(n).toBe(1);
  });

  test('« Mes demandes » : le locataire ne voit que les siennes ; celle d’un autre → 403', async () => {
    const mienne = (await signaler(locA, { title: 'Serrure bloquée', category: 'serrure' })).body.data.incident;
    const autre = (await signaler(locAutre, { title: 'Clim en panne', category: 'climatisation' })).body.data.incident;

    const liste = await loc().get(URL_LOC).set(locA.h);
    expect(liste.status).toBe(200);
    expect(liste.body.data.items.length).toBeGreaterThan(0);
    expect(liste.body.data.items.every((i) => i.tenant_id === bail.tenant.id)).toBe(true);
    expect(liste.body.data.items.some((i) => i.id === autre.id)).toBe(false);

    expect((await loc().get(`${URL_LOC}/${mienne.id}`).set(locA.h)).status).toBe(200);
    const interdit = await loc().get(`${URL_LOC}/${autre.id}`).set(locA.h);
    expect(interdit.status).toBe(403);
    expect(interdit.body.error.code).toBe('ACCES_AUTRE_LOCATAIRE');
    expect((await loc().post(`${URL_LOC}/${autre.id}/pieces`).set(locA.h).attach('fichier', png, 'p.png')).status).toBe(403);
    expect((await loc().get(`${URL_LOC}/${crypto.randomUUID()}`).set(locA.h)).status).toBe(404);
    // Un propriétaire n'entre pas dans l'espace locataire.
    expect((await loc().get(URL_LOC).set(a.h)).status).toBe(403);
  });

  test('pièces jointes du locataire : photo partagée, refusée une fois les travaux planifiés', async () => {
    const inc = (await signaler(locA, { title: 'Porte fendue', category: 'porte' })).body.data.incident;
    const piece = await loc().post(`${URL_LOC}/${inc.id}/pieces`).set(locA.h).attach('fichier', png, 'porte.png');
    expect(piece.status).toBe(201);
    expect(piece.body.data.document).toMatchObject({ category: 'photo', visible_to_tenant: true });
    expect((await loc().post(`${URL_LOC}/${inc.id}/pieces`).set(locA.h).attach('fichier', Buffer.from('%PDF-1.4 xxxxxxxx'), 'x.pdf')).status).toBe(400);

    // Le propriétaire voit la pièce dans le détail.
    const detail = await api().get(`/api/v1/incidents/${inc.id}`).set(a.h);
    expect(detail.body.data.incident.documents).toHaveLength(1);
    expect(detail.body.data.incident.tenant.id).toBe(bail.tenant.id);

    await api().post(`/api/v1/incidents/${inc.id}/travaux`).set(a.h).send({});
    const refus = await loc().post(`${URL_LOC}/${inc.id}/pieces`).set(locA.h).attach('fichier', png, 'porte.png');
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('INCIDENT_PIECES_CLOSES');
  });

  test('workflow § 23 : analyse → travaux → terminé ⇒ incident résolu, locataire notifié', async () => {
    const inc = (await signaler(locA)).body.data.incident;

    const analyse = await api().post(`/api/v1/incidents/${inc.id}/analyser`).set(a.h).send({ note: 'Passage prévu mardi' });
    expect(analyse.status).toBe(200);
    expect(analyse.body.data.incident).toMatchObject({ status: 'en_analyse', owner_note: 'Passage prévu mardi' });
    expect(analyse.body.data.incident.analysed_at).not.toBeNull();
    expect((await notifications(locA.user.id, 'incident')).some((n) => n.data.incident_id === inc.id && n.data.status === 'en_analyse')).toBe(true);

    const cree = await api().post(`/api/v1/incidents/${inc.id}/travaux`).set(a.h).send({ estimated_amount: 50000 });
    expect(cree.status).toBe(201);
    const wo = cree.body.data.work_order;
    expect(wo).toMatchObject({
      incident_id: inc.id, status: 'valide', category: 'plomberie', title: inc.title,
      building_id: bail.building.id, apartment_id: bail.apartment.id, reference: expect.stringMatching(/^#\d{5}$/),
    });
    const suivi = await api().get(`/api/v1/incidents/${inc.id}`).set(a.h);
    expect(suivi.body.data.incident.status).toBe('travaux_planifies');
    expect(suivi.body.data.incident.work_orders).toHaveLength(1);

    // Le locataire suit l'intervention, sans les montants.
    const vueLocataire = (await loc().get(`${URL_LOC}/${inc.id}`).set(locA.h)).body.data.incident;
    expect(vueLocataire.status).toBe('travaux_planifies');
    expect(vueLocataire.work_orders[0]).not.toHaveProperty('estimated_amount');

    expect((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(a.h).send({ status: 'en_cours' })).status).toBe(200);
    expect((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(a.h).send({ status: 'termine' })).status).toBe(200);

    const final = (await api().get(`/api/v1/incidents/${inc.id}`).set(a.h)).body.data.incident;
    expect(final.status).toBe('resolu');
    expect(final.resolved_at).not.toBeNull();
    const termine = await notifications(locA.user.id, 'travail_termine');
    expect(termine.some((n) => n.data.incident_id === inc.id && n.data.status === 'resolu')).toBe(true);
    // Incident clos : plus de nouveaux travaux (transition interdite).
    const encore = await api().post(`/api/v1/incidents/${inc.id}/travaux`).set(a.h).send({});
    expect(encore.status).toBe(409);
    expect(encore.body.error.code).toBe('TRANSITION_INVALIDE');
  });

  test('travaux annulés : l’incident repasse « en analyse »', async () => {
    const inc = (await signaler(locA, { category: 'panne_electrique', title: 'Plus de courant' })).body.data.incident;
    const wo = (await api().post(`/api/v1/incidents/${inc.id}/travaux`).set(a.h).send({ status: 'signale' })).body.data.work_order;
    expect(wo.category).toBe('electricite');
    await api().post(`/api/v1/travaux/${wo.id}/statut`).set(a.h).send({ status: 'annule', comment: 'Disjoncteur réarmé' });
    expect((await api().get(`/api/v1/incidents/${inc.id}`).set(a.h)).body.data.incident.status).toBe('en_analyse');
  });

  test('rejet motivé ; transitions interdites → 409 TRANSITION_INVALIDE', async () => {
    const inc = (await signaler(locA, { category: 'autre', title: 'Voisin bruyant' })).body.data.incident;
    expect((await api().post(`/api/v1/incidents/${inc.id}/rejeter`).set(a.h).send({})).status).toBe(422);
    const rejet = await api().post(`/api/v1/incidents/${inc.id}/rejeter`).set(a.h).send({ reason: 'Hors du périmètre du bailleur' });
    expect(rejet.status).toBe(200);
    expect(rejet.body.data.incident).toMatchObject({ status: 'rejete', rejection_reason: 'Hors du périmètre du bailleur' });
    const vue = (await loc().get(`${URL_LOC}/${inc.id}`).set(locA.h)).body.data.incident;
    expect(vue.rejection_reason).toBe('Hors du périmètre du bailleur');

    const resoudre = await api().post(`/api/v1/incidents/${inc.id}/resoudre`).set(a.h).send({});
    expect(resoudre.status).toBe(409);
    expect(resoudre.body.error.code).toBe('TRANSITION_INVALIDE');
    expect((await api().post(`/api/v1/incidents/${inc.id}/analyser`).set(a.h).send({})).status).toBe(409);
    expect((await api().post(`/api/v1/incidents/${inc.id}/travaux`).set(a.h).send({})).status).toBe(409);
  });

  test('incident de partie commune déclaré par le propriétaire ; liste filtrée', async () => {
    const p = await nouveauProprietaire();
    const bat = await creerImmeuble(p);
    const autreBat = await creerImmeuble(p);
    const aptAutre = await creerAppartement(p, autreBat.id);
    const res = await api().post('/api/v1/incidents').set(p.h)
      .send({ building_id: bat.id, category: 'probleme_commun', title: 'Ascenseur bloqué', description: 'Bloqué au 3e étage' });
    expect(res.status).toBe(201);
    expect(res.body.data.incident).toMatchObject({ tenant_id: null, building_id: bat.id, status: 'signale', reference: expect.stringMatching(/^INC-\d{4}-00001$/) });
    expect((await api().post('/api/v1/incidents').set(p.h).send({ building_id: bat.id, apartment_id: aptAutre.id, category: 'fuite', title: 'Fuite', description: 'xx' })).status).toBe(422);
    expect((await api().post('/api/v1/incidents').set(p.h).send({ category: 'fuite', title: 'Fuite', description: 'xx' })).status).toBe(422);
    expect((await api().post(`/api/v1/incidents/${res.body.data.incident.id}/resoudre`).set(p.h).send({ note: 'Technicien passé' })).body.data.incident.status).toBe('resolu');

    const parLocataire = await api().get('/api/v1/incidents').query({ tenant_id: bail.tenant.id }).set(a.h);
    expect(parLocataire.body.data.items.length).toBeGreaterThan(0);
    expect(parLocataire.body.data.items.every((i) => i.tenant_id === bail.tenant.id)).toBe(true);
    const resolus = await api().get('/api/v1/incidents').query({ status: 'resolu', building_id: bat.id }).set(p.h);
    expect(resolus.body.data.pagination.total).toBe(1);
    expect((await api().get('/api/v1/incidents').query({ status: 'ferme' }).set(p.h)).status).toBe(422);
  });

  test('cloisonnement propriétaire : B → 403 ; inconnu → 404', async () => {
    const inc = (await signaler(locA)).body.data.incident;
    expect((await api().get(`/api/v1/incidents/${inc.id}`).set(b.h)).status).toBe(403);
    expect((await api().post(`/api/v1/incidents/${inc.id}/analyser`).set(b.h).send({})).status).toBe(403);
    expect((await api().post(`/api/v1/incidents/${inc.id}/travaux`).set(b.h).send({})).status).toBe(403);
    expect((await api().post('/api/v1/incidents').set(b.h).send({ building_id: bail.building.id, category: 'fuite', title: 'Fuite', description: 'xx' })).status).toBe(403);
    expect((await api().get('/api/v1/incidents').set(b.h)).body.data.items.some((i) => i.id === inc.id)).toBe(false);
    expect((await api().get(`/api/v1/incidents/${crypto.randomUUID()}`).set(a.h)).status).toBe(404);
  });
});
