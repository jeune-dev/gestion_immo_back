'use strict';

const express = require('express');
const request = require('supertest');
const sharp = require('sharp');
const { QueryTypes } = require('sequelize');
const app = require('../../../../app.js');
const requestId = require('../../../../middlewares/requestId.middleware.js');
const auth = require('../../../../middlewares/auth.middleware.js');
const { requireLocataire } = require('../../../../middlewares/acces.middleware.js');
const errorHandler = require('../../../../middlewares/errorHandler.middleware.js');
const routeurLocataire = require('../../../../modules/etatDesLieux/route/etatDesLieuxLocataire.route.js');
const { accepterTacitement } = require('../../../../modules/etatDesLieux/service/etatDesLieux.service.js');
const {
  nouveauProprietaire, creerImmeuble, creerAppartement, creerLocataire, activerLocataire, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 52 État des lieux avec photos — et § 56.2 « saisie hors ligne puis
 * synchronisation ; photo horodatée ; contestation du locataire ; comparaison
 * entrée / sortie ; état accepté non modifiable ».
 *
 * Le routeur locataire est monté ici derrière la MÊME garde que l'espace
 * locataire de routes.js (auth → requireLocataire) ; le reste de l'API passe
 * par l'application réelle.
 */
const PREFIXE_LOCATAIRE = '/api/v1/locataire/etats-des-lieux';
const harnais = express();
harnais.use(PREFIXE_LOCATAIRE, requestId, express.json(), auth, requireLocataire, routeurLocataire);
harnais.use(app);
harnais.use(errorHandler);
const api = () => request(harnais);

const EDL = '/api/v1/etats-des-lieux';

/** Lecture binaire d'une réponse (PDF). */
const binaire = (res, cb) => {
  const morceaux = [];
  res.on('data', (m) => morceaux.push(m));
  res.on('end', () => cb(null, Buffer.concat(morceaux)));
};

const png = () => sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).png().toBuffer();

async function nouveauBail(proprio, appartement = {}) {
  const building = await creerImmeuble(proprio);
  const apartment = await creerAppartement(proprio, building.id, appartement);
  const tenant = await creerLocataire(proprio);
  const res = await api().post('/api/v1/baux').set(proprio.h)
    .send({ apartment_id: apartment.id, tenant_id: tenant.id, start_date: '2026-09-01', rent_amount: apartment.rent_amount, deposit_amount: 0, due_day: 5 });
  if (res.status !== 201) throw new Error(`Bail : ${res.status} ${JSON.stringify(res.body)}`);
  return { lease: res.body.data.lease, apartment, tenant };
}

const elements = (edl) => edl.rooms.flatMap((r) => r.items);

/** Statut attendu d'une étape de préparation ; sinon erreur explicite. */
function attendu(res, statut, etape) {
  if (res.status !== statut) throw new Error(`${etape} : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Étapes du cycle de vie d'un état des lieux, dans l'ordre. */
const ETAPES = ['bail', 'brouillon', 'saisi', 'photo', 'soumis', 'corrige', 'accepte', 'sortie'];

/**
 * Construit PAR L'API, pour un propriétaire / bail / locataire DÉDIÉS, un état
 * des lieux arrivé à l'étape demandée (chaque étape inclut les précédentes) :
 *   bail       bail en attente (F3 meublé), locataire activé, aucun état des lieux ;
 *   brouillon  état des lieux d'entrée créé depuis le bail ;
 *   saisi      en-tête (compteurs, 3 clés), climatiseur ajouté au salon,
 *              commentaire sur les murs, saisie groupée (sols « usage ») ;
 *   photo      photo horodatée sur les sols du salon ;
 *   soumis     soumis au locataire, puis bail activé ;
 *   corrige    contesté par le locataire, corrigé → version 2 en brouillon ;
 *   accepte    version 2 soumise puis acceptée par le locataire ;
 *   sortie     état des lieux de sortie créé et saisi (murs du salon hors service).
 * `entree` est la réponse de création (ou de correction à partir de « corrige ») ;
 * `v1` l'identifiant de la première version.
 */
async function preparerEdl(etape) {
  const niveau = ETAPES.indexOf(etape);
  if (niveau < 0) throw new Error(`Étape inconnue : ${etape}`);
  const proprio = await nouveauProprietaire();
  const bail = await nouveauBail(proprio, { type: 'f3', is_furnished: true });
  const locataire = await activerLocataire(proprio, bail.tenant);
  const ctx = {
    proprio, bail, locataire, entree: null, v1: null, sortie: null,
  };
  if (niveau < ETAPES.indexOf('brouillon')) return ctx;

  ctx.entree = attendu(await api().post(EDL).set(proprio.h).send({
    lease_id: bail.lease.id, type: 'entree', parties_present: [{ name: 'Balla Diop', role: 'bailleur' }, { name: 'Mamadou Ndiaye', role: 'locataire' }],
  }), 201, 'Création').inspection;
  ctx.v1 = ctx.entree.id;
  const id = ctx.entree.id;
  if (niveau < ETAPES.indexOf('saisi')) return ctx;

  attendu(await api().patch(`${EDL}/${id}`).set(proprio.h)
    .send({ water_meter: 123.456, electricity_meter: 4567, keys_count: 3, keys_details: '2 clés porte, 1 badge', general_observations: 'Logement propre' }), 200, 'En-tête');
  const salon = ctx.entree.rooms[0];
  attendu(await api().post(`${EDL}/${id}/pieces/${salon.id}/elements`).set(proprio.h).send({ element: 'autre', label: 'Climatiseur', condition: 'usage' }), 201, 'Élément');
  const murs = salon.items.find((i) => i.element === 'murs');
  const sols = salon.items.find((i) => i.element === 'sols');
  attendu(await api().patch(`${EDL}/${id}/elements/${murs.id}`).set(proprio.h).send({ comment: 'Peinture récente' }), 200, 'Murs');
  const lot = [
    { item_id: sols.id, condition: 'usage', comment: 'Rayures légères' },
    { item_id: murs.id, condition: 'bon' },
    ...elements(ctx.entree).filter((i) => ![sols.id, murs.id].includes(i.id)).slice(0, 10).map((i) => ({ item_id: i.id, condition: 'bon', comment: null })),
  ];
  attendu(await api().put(`${EDL}/${id}/saisie`).set(proprio.h).send({ items: lot }), 200, 'Saisie');
  if (niveau < ETAPES.indexOf('photo')) return ctx;

  attendu(await api().post(`${EDL}/${id}/elements/${sols.id}/photos`).set(proprio.h)
    .field('captured_at', '2026-09-20T10:15:00.000Z').attach('fichier', await png(), 'p.png'), 201, 'Photo');
  if (niveau < ETAPES.indexOf('soumis')) return ctx;

  attendu(await api().post(`${EDL}/${id}/soumettre`).set(proprio.h).send({}), 200, 'Soumission');
  attendu(await api().post(`/api/v1/baux/${bail.lease.id}/activer`).set(proprio.h).send({}), 200, 'Activation du bail');
  if (niveau < ETAPES.indexOf('corrige')) return ctx;

  attendu(await api().post(`${PREFIXE_LOCATAIRE}/${id}/contester`).set(locataire.h)
    .send({ comment: 'Le sol de la chambre 1 est rayé, ce n’est pas indiqué.' }), 200, 'Contestation');
  ctx.entree = attendu(await api().post(`${EDL}/${id}/corriger`).set(proprio.h).send({}), 201, 'Correction').inspection;
  if (niveau < ETAPES.indexOf('accepte')) return ctx;

  attendu(await api().post(`${EDL}/${ctx.entree.id}/soumettre`).set(proprio.h).send({}), 200, 'Soumission v2');
  attendu(await api().post(`${PREFIXE_LOCATAIRE}/${ctx.entree.id}/accepter`).set(locataire.h).send({}), 200, 'Acceptation');
  if (niveau < ETAPES.indexOf('sortie')) return ctx;

  ctx.sortie = attendu(await api().post(EDL).set(proprio.h).send({ lease_id: bail.lease.id, type: 'sortie' }), 201, 'Sortie').inspection;
  ctx.sortie = attendu(await api().put(`${EDL}/${ctx.sortie.id}/saisie`).set(proprio.h).send({ items: lotSortie(ctx.entree, ctx.sortie) }), 200, 'Saisie de sortie').inspection;
  return ctx;
}

/** Saisie de sortie : états d'entrée repris, murs du salon dégradés. */
function lotSortie(entree, sortie) {
  // Même trame : on reprend les états d'entrée, puis on dégrade les murs du salon.
  const etatsEntree = new Map(entree.rooms.flatMap((r) => r.items.map((i) => [`${r.name}|${i.element}|${i.label || ''}`, i.condition])));
  const lot = sortie.rooms.flatMap((r) => r.items.map((i) => ({ item_id: i.id, condition: etatsEntree.get(`${r.name}|${i.element}|${i.label || ''}`) || 'bon' })));
  const mursSalon = sortie.rooms[0].items.find((i) => i.element === 'murs');
  lot.find((l) => l.item_id === mursSalon.id).condition = 'hors_service';
  lot.find((l) => l.item_id === mursSalon.id).comment = 'Mur fissuré';
  return lot;
}

describe('États des lieux (§ 52)', () => {
  // Autre propriétaire / locataire : LECTURE SEULE (tentatives refusées
  // uniquement). Chaque test prépare son propre état des lieux (preparerEdl),
  // l'ordre d'exécution est donc indifférent.
  let autreProprio;
  let autreLocataire;

  beforeAll(async () => {
    autreProprio = await nouveauProprietaire();
    const bailAutre = await nouveauBail(autreProprio);
    autreLocataire = await activerLocataire(autreProprio, bailAutre.tenant);
  });

  afterAll(fermer);

  test('création depuis le bail avec la trame de pièces du type d’appartement (§ 52.3 étape 1), idempotente', async () => {
    const { proprio, bail } = await preparerEdl('bail');
    const corps = {
      lease_id: bail.lease.id, type: 'entree', parties_present: [{ name: 'Balla Diop', role: 'bailleur' }, { name: 'Mamadou Ndiaye', role: 'locataire' }],
    };
    const res = await api().post(EDL).set(proprio.h).set('Idempotency-Key', 'edl-creation-0001').send(corps);
    expect(res.status).toBe(201);
    const entree = res.body.data.inspection;
    expect(entree).toMatchObject({ type: 'entree', status: 'brouillon', version: 1, tenant_id: bail.tenant.id, apartment_id: bail.apartment.id });
    expect(entree.rooms.map((r) => r.name)).toEqual(['Salon / Séjour', 'Chambre 1', 'Chambre 2', 'Cuisine', 'Salle de bain', 'WC', 'Balcon / Terrasse']);
    expect(entree.rooms[0].items.map((i) => i.element)).toContain('mobilier');
    expect(entree.rooms.find((r) => r.name === 'WC').items.map((i) => i.element)).toEqual(expect.arrayContaining(['plomberie', 'sanitaires']));

    const rejeu = await api().post(EDL).set(proprio.h).set('Idempotency-Key', 'edl-creation-0001').send(corps);
    expect(rejeu.status).toBe(201);
    expect(rejeu.headers['idempotent-replayed']).toBe('true');
    expect(rejeu.body.data.inspection.id).toBe(entree.id);

    const doublon = await api().post(EDL).set(proprio.h).send(corps);
    expect(doublon.status).toBe(409);
    expect(doublon.body.error.code).toBe('ETAT_DES_LIEUX_EXISTANT');

    const sortieTropTot = await api().post(EDL).set(proprio.h).send({ lease_id: bail.lease.id, type: 'sortie' });
    expect(sortieTropTot.status).toBe(409);
    expect(sortieTropTot.body.error.code).toBe('BAIL_STATUT_INCOMPATIBLE');

    expect((await api().post(EDL).set(proprio.h).send({ lease_id: bail.lease.id, type: 'inventaire' })).status).toBe(422);
    expect((await api().post(EDL).set(autreProprio.h).send({ lease_id: bail.lease.id, type: 'entree' })).status).toBe(403);
  });

  test('accès : autre propriétaire 403, identifiant inconnu 404, liste filtrée', async () => {
    const { proprio, bail, entree } = await preparerEdl('brouillon');
    expect((await api().get(`${EDL}/${entree.id}`).set(autreProprio.h)).status).toBe(403);
    expect((await api().patch(`${EDL}/${entree.id}`).set(autreProprio.h).send({ keys_count: 1 })).status).toBe(403);
    expect((await api().get(`${EDL}/00000000-0000-4000-8000-000000000000`).set(proprio.h)).status).toBe(404);
    const liste = await api().get(EDL).query({ lease_id: bail.lease.id }).set(proprio.h);
    expect(liste.status).toBe(200);
    expect(liste.body.data.items.map((i) => i.id)).toEqual([entree.id]);
    expect((await api().get(EDL).set(autreProprio.h)).body.data.items).toHaveLength(0);
  });

  test('saisie : en-tête, pièce ajoutée, élément modifié, saisie groupée hors ligne (§ 52.4)', async () => {
    const { proprio, entree } = await preparerEdl('brouillon');
    const entete = await api().patch(`${EDL}/${entree.id}`).set(proprio.h)
      .send({ water_meter: 123.456, electricity_meter: 4567, keys_count: 3, keys_details: '2 clés porte, 1 badge', general_observations: 'Logement propre' });
    expect(entete.status).toBe(200);
    expect(Number(entete.body.data.inspection.water_meter)).toBeCloseTo(123.456);

    const piece = await api().post(`${EDL}/${entree.id}/pieces`).set(proprio.h).send({ name: 'Toilettes invités' });
    expect(piece.status).toBe(201);
    expect(piece.body.data.room.items.map((i) => i.element)).toContain('sanitaires');
    expect(piece.body.data.room.position).toBe(7);
    const suppression = await api().delete(`${EDL}/${entree.id}/pieces/${piece.body.data.room.id}`).set(proprio.h);
    expect(suppression.status).toBe(200);

    const salon = entree.rooms[0];
    const ajout = await api().post(`${EDL}/${entree.id}/pieces/${salon.id}/elements`).set(proprio.h).send({ element: 'autre', label: 'Climatiseur', condition: 'usage' });
    expect(ajout.status).toBe(201);
    const murs = salon.items.find((i) => i.element === 'murs');
    const modif = await api().patch(`${EDL}/${entree.id}/elements/${murs.id}`).set(proprio.h).send({ comment: 'Peinture récente' });
    expect(modif.status).toBe(200);
    expect(modif.body.data.item.comment).toBe('Peinture récente');

    const tous = elements(entree);
    const sols = salon.items.find((i) => i.element === 'sols');
    const lot = [
      { item_id: sols.id, condition: 'usage', comment: 'Rayures légères' },
      { item_id: murs.id, condition: 'bon' },
      ...tous.filter((i) => ![sols.id, murs.id].includes(i.id)).slice(0, 10).map((i) => ({ item_id: i.id, condition: 'bon', comment: null })),
    ];
    const saisie = await api().put(`${EDL}/${entree.id}/saisie`).set(proprio.h).send({ items: lot });
    expect(saisie.status).toBe(200);
    const apres = elements(saisie.body.data.inspection);
    expect(apres.find((i) => i.id === sols.id)).toMatchObject({ condition: 'usage', comment: 'Rayures légères' });
    // Commentaire absent du lot : conservé.
    expect(apres.find((i) => i.id === murs.id).comment).toBe('Peinture récente');

    // Un élément d'un autre état des lieux (ou inventé) fait rejeter tout le lot.
    const etranger = await api().put(`${EDL}/${entree.id}/saisie`).set(proprio.h)
      .send({ items: [{ item_id: sols.id, condition: 'bon' }, { item_id: '00000000-0000-4000-8000-000000000001', condition: 'bon' }] });
    expect(etranger.status).toBe(422);
    expect(etranger.body.error.code).toBe('ELEMENT_ETRANGER');
    expect((await api().put(`${EDL}/${entree.id}/saisie`).set(proprio.h).send({ items: [{ item_id: sols.id, condition: 'neuf' }] })).status).toBe(422);
  });

  test('photo par élément : prise de vue conservée, horodatage serveur (§ 52.4)', async () => {
    const { proprio, entree } = await preparerEdl('saisi');
    const sols = entree.rooms[0].items.find((i) => i.element === 'sols');
    const prise = '2026-09-20T10:15:00.000Z';
    const res = await api().post(`${EDL}/${entree.id}/elements/${sols.id}/photos`).set(proprio.h)
      .field('captured_at', prise).attach('fichier', await png(), 'p.png');
    expect(res.status).toBe(201);
    const { photo } = res.body.data;
    expect(new Date(photo.captured_at).toISOString()).toBe(prise);
    expect(photo.created_at).toBeTruthy();
    // Photo d'un brouillon : cachée au locataire jusqu'à la soumission (§ 52.3 étape 3).
    expect(photo.document).toMatchObject({ category: 'photo', visible_to_tenant: false, has_thumbnail: true });
    expect(photo.document).not.toHaveProperty('storage_key');

    const detail = await api().get(`${EDL}/${entree.id}`).set(proprio.h);
    const photos = elements(detail.body.data.inspection).find((i) => i.id === sols.id).photos;
    expect(photos).toHaveLength(1);
    expect(photos[0].document.id).toBe(photo.document.id);

    const refus = await api().post(`${EDL}/${entree.id}/elements/${sols.id}/photos`).set(proprio.h).attach('fichier', Buffer.from('pas une image, juste du texte'), 'p.png');
    expect(refus.status).toBe(400);
  });

  test('PDF d’un brouillon généré à la volée', async () => {
    const { proprio, entree } = await preparerEdl('photo');
    const res = await api().get(`${EDL}/${entree.id}/pdf`).set(proprio.h).buffer(true).parse(binaire);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('soumission : délai de réponse, notification ; bail activable ensuite (politique « bloquant »)', async () => {
    const {
      proprio, bail, locataire, entree,
    } = await preparerEdl('photo');
    // Le locataire ne voit pas un brouillon.
    expect((await api().get(`${PREFIXE_LOCATAIRE}/${entree.id}`).set(locataire.h)).status).toBe(404);
    const activationTropTot = await api().post(`/api/v1/baux/${bail.lease.id}/activer`).set(proprio.h).send({});
    expect(activationTropTot.status).toBe(409);
    expect(activationTropTot.body.error.code).toBe('ETAT_DES_LIEUX_ENTREE_REQUIS');

    const res = await api().post(`${EDL}/${entree.id}/soumettre`).set(proprio.h).send({});
    expect(res.status).toBe(200);
    const edl = res.body.data.inspection;
    expect(edl.status).toBe('soumis');
    const jours = (new Date(edl.response_deadline) - new Date(edl.submitted_at)) / 86_400_000;
    expect(jours).toBeCloseTo(7, 5);
    expect(edl.performed_at).toBeTruthy();

    const [notif] = await sequelize.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = :u AND type = 'etat_des_lieux'", { replacements: { u: locataire.user.id }, type: QueryTypes.SELECT });
    expect(notif.n).toBe(1);

    // Soumis : plus aucune modification.
    const modif = await api().patch(`${EDL}/${entree.id}`).set(proprio.h).send({ keys_count: 4 });
    expect(modif.status).toBe(409);
    expect(modif.body.error.code).toBe('ETAT_DES_LIEUX_VERROUILLE');
    expect((await api().post(`${EDL}/${entree.id}/soumettre`).set(proprio.h).send({})).status).toBe(409);

    const activation = await api().post(`/api/v1/baux/${bail.lease.id}/activer`).set(proprio.h).send({});
    expect(activation.status).toBe(200);
    expect(activation.body.data.lease.status).toBe('actif');
  });

  test('locataire : liste et détail de SES états des lieux ; autre locataire 403', async () => {
    const { proprio, locataire, entree } = await preparerEdl('soumis');
    const liste = await api().get(PREFIXE_LOCATAIRE).set(locataire.h);
    expect(liste.status).toBe(200);
    expect(liste.body.data.items.map((i) => i.id)).toEqual([entree.id]);
    const detail = await api().get(`${PREFIXE_LOCATAIRE}/${entree.id}`).set(locataire.h);
    expect(detail.status).toBe(200);
    expect(elements(detail.body.data.inspection).some((i) => i.photos.length === 1)).toBe(true);
    expect(detail.body.data.inspection).not.toHaveProperty('created_by');

    expect((await api().get(`${PREFIXE_LOCATAIRE}/${entree.id}`).set(autreLocataire.h)).status).toBe(403);
    expect((await api().post(`${PREFIXE_LOCATAIRE}/${entree.id}/accepter`).set(autreLocataire.h).send({})).status).toBe(403);
    expect((await api().get(PREFIXE_LOCATAIRE).set(autreLocataire.h)).body.data.items).toHaveLength(0);
    // Un propriétaire n'entre pas dans l'espace locataire.
    expect((await api().get(PREFIXE_LOCATAIRE).set(proprio.h)).status).toBe(403);
  });

  test('contestation puis correction : nouvelle version tracée, photos reprises (§ 52.4, § 56.1)', async () => {
    const { proprio, locataire, entree } = await preparerEdl('soumis');
    expect((await api().post(`${PREFIXE_LOCATAIRE}/${entree.id}/contester`).set(locataire.h).send({ comment: 'court' })).status).toBe(422);
    const contest = await api().post(`${PREFIXE_LOCATAIRE}/${entree.id}/contester`).set(locataire.h)
      .send({ comment: 'Le sol de la chambre 1 est rayé, ce n’est pas indiqué.' });
    expect(contest.status).toBe(200);
    expect(contest.body.data.inspection).toMatchObject({ status: 'conteste' });
    expect(contest.body.data.inspection.contest_comment).toMatch(/rayé/);
    expect((await api().post(`${PREFIXE_LOCATAIRE}/${entree.id}/accepter`).set(locataire.h).send({})).status).toBe(409);

    const correction = await api().post(`${EDL}/${entree.id}/corriger`).set(proprio.h).send({});
    expect(correction.status).toBe(201);
    const v2 = correction.body.data.inspection;
    expect(v2).toMatchObject({ version: 2, status: 'brouillon', previous_version_id: entree.id, keys_count: 3 });
    expect(v2.versions.map((v) => [v.version, v.status])).toEqual([[2, 'brouillon'], [1, 'remplace']]);
    const ancien = await api().get(`${EDL}/${entree.id}`).set(proprio.h);
    expect(ancien.body.data.inspection.status).toBe('remplace');
    // Mêmes éléments, mêmes états ; la photo est reprise par un NOUVEAU document.
    const avant = elements(ancien.body.data.inspection);
    const apres = elements(v2);
    expect(apres).toHaveLength(avant.length);
    expect(apres.map((i) => i.condition)).toEqual(avant.map((i) => i.condition));
    const photoV1 = avant.flatMap((i) => i.photos)[0];
    const photoV2 = apres.flatMap((i) => i.photos)[0];
    expect(photoV2.document.id).not.toBe(photoV1.document.id);
    expect(photoV2.captured_at).toBe(photoV1.captured_at);
    const [cles] = await sequelize.query('SELECT count(DISTINCT storage_key)::int AS n FROM documents WHERE id IN (:ids)', { replacements: { ids: [photoV1.document.id, photoV2.document.id] }, type: QueryTypes.SELECT });
    expect(cles.n).toBe(1);

    const audit = await sequelize.query('SELECT action FROM audit_logs WHERE entity_id IN (:ids) ORDER BY created_at', { replacements: { ids: [entree.id, v2.id] }, type: QueryTypes.SELECT });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['etat_des_lieux.creation', 'etat_des_lieux.modification', 'etat_des_lieux.ajout_document', 'etat_des_lieux.changement_statut', 'etat_des_lieux.nouvelle_version']));

    // Une version corrigée fait partie de l'historique : pas de suppression.
    const suppression = await api().delete(`${EDL}/${v2.id}`).set(proprio.h);
    expect(suppression.status).toBe(409);
    expect(suppression.body.error.code).toBe('ETAT_DES_LIEUX_HISTORISE');
    // Le locataire voit la version remplacée, pas le nouveau brouillon.
    const vue = await api().get(PREFIXE_LOCATAIRE).set(locataire.h);
    expect(vue.body.data.items.map((i) => [i.version, i.status])).toEqual([[1, 'remplace']]);
  });

  test('acceptation par le locataire : verrouillé, PDF archivé, toute écriture refusée (§ 52.3 étape 4, § 56.1)', async () => {
    // Version 2 (corrigée) en brouillon, comme après une contestation.
    const {
      proprio, bail, locataire, entree,
    } = await preparerEdl('corrige');
    expect((await api().post(`${EDL}/${entree.id}/soumettre`).set(proprio.h).send({})).status).toBe(200);
    const res = await api().post(`${PREFIXE_LOCATAIRE}/${entree.id}/accepter`).set(locataire.h).send({});
    expect(res.status).toBe(200);
    const edl = res.body.data.inspection;
    expect(edl).toMatchObject({ status: 'accepte', accepted_tacitly: false });
    expect(edl.locked_at).toBeTruthy();
    expect(edl.document_id).toBeTruthy();
    const [doc] = await sequelize.query('SELECT category, visible_to_tenant, tenant_id FROM documents WHERE id = :id', { replacements: { id: edl.document_id }, type: QueryTypes.SELECT });
    expect(doc).toMatchObject({ category: 'etat_des_lieux', visible_to_tenant: true, tenant_id: bail.tenant.id });

    const item = elements(edl)[0];
    const refus = [
      await api().patch(`${EDL}/${entree.id}`).set(proprio.h).send({ keys_count: 9 }),
      await api().put(`${EDL}/${entree.id}/saisie`).set(proprio.h).send({ items: [{ item_id: item.id, condition: 'degrade' }] }),
      await api().patch(`${EDL}/${entree.id}/elements/${item.id}`).set(proprio.h).send({ condition: 'degrade' }),
      await api().delete(`${EDL}/${entree.id}/elements/${item.id}`).set(proprio.h),
      await api().post(`${EDL}/${entree.id}/pieces`).set(proprio.h).send({ name: 'Garage' }),
      await api().post(`${EDL}/${entree.id}/elements/${item.id}/photos`).set(proprio.h).attach('fichier', await png(), 'p.png'),
      await api().delete(`${EDL}/${entree.id}`).set(proprio.h),
    ];
    for (const r of refus) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('ETAT_DES_LIEUX_VERROUILLE');
    }
    expect((await api().post(`${PREFIXE_LOCATAIRE}/${entree.id}/contester`).set(locataire.h).send({ comment: 'Je change d’avis finalement.' })).status).toBe(409);

    for (const [chemin, h] of [[`${EDL}/${entree.id}/pdf`, proprio.h], [`${PREFIXE_LOCATAIRE}/${entree.id}/pdf`, locataire.h]]) {
      const pdf = await api().get(chemin).set(h).buffer(true).parse(binaire);
      expect(pdf.status).toBe(200);
      expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect((await api().get(`${PREFIXE_LOCATAIRE}/${entree.id}/pdf`).set(autreLocataire.h)).status).toBe(403);
  });

  test('sortie comparée à l’entrée, élément par élément (§ 52.3 étape 5)', async () => {
    // Entrée corrigée (version 2) puis acceptée ; bail actif.
    const { proprio, bail, entree } = await preparerEdl('accepte');
    const creation = await api().post(EDL).set(proprio.h).send({ lease_id: bail.lease.id, type: 'sortie' });
    expect(creation.status).toBe(201);
    const sortie = creation.body.data.inspection;
    // Même trame : états d'entrée repris, murs du salon dégradés (lotSortie).
    expect((await api().put(`${EDL}/${sortie.id}/saisie`).set(proprio.h).send({ items: lotSortie(entree, sortie) })).status).toBe(200);

    const res = await api().get(`${EDL}/comparaison`).query({ lease_id: bail.lease.id }).set(proprio.h);
    expect(res.status).toBe(200);
    const c = res.body.data.comparaison;
    expect(c.entree.id).toBe(entree.id);
    expect(c.sortie.id).toBe(sortie.id);
    expect(c.ecarts).toHaveLength(1);
    expect(c.ecarts[0]).toMatchObject({ piece: 'Salon / Séjour', element: 'murs', entree: { condition: 'bon', comment: 'Peinture récente' }, sortie: { condition: 'hors_service', comment: 'Mur fissuré' } });
    // L'élément ajouté à l'entrée (climatiseur) n'est pas dans la trame de sortie.
    expect(c.absents.map((a) => a.label)).toEqual(['Climatiseur']);
    expect(c.resume.nouveaux).toBe(0);

    expect((await api().get(`${EDL}/comparaison`).query({ lease_id: bail.lease.id }).set(autreProprio.h)).status).toBe(403);
    expect((await api().get(`${EDL}/comparaison`).set(proprio.h)).status).toBe(422);
  });

  test('acceptation tacite à l’échéance du délai (tâche planifiée) ; réponse hors délai refusée', async () => {
    // Sortie saisie (brouillon) après une entrée acceptée.
    const { proprio, bail, locataire } = await preparerEdl('sortie');
    const [sortie] = await sequelize.query("SELECT id FROM inspections WHERE lease_id = :l AND type = 'sortie'", { replacements: { l: bail.lease.id }, type: QueryTypes.SELECT });
    expect((await api().post(`${EDL}/${sortie.id}/soumettre`).set(proprio.h).send({})).status).toBe(200);
    await sequelize.query("UPDATE inspections SET response_deadline = now() - interval '1 hour' WHERE id = :id", { replacements: { id: sortie.id } });

    const horsDelai = await api().post(`${PREFIXE_LOCATAIRE}/${sortie.id}/contester`).set(locataire.h).send({ comment: 'Je conteste bien trop tard.' });
    expect(horsDelai.status).toBe(409);
    expect(horsDelai.body.error.code).toBe('DELAI_DEPASSE');

    const bilan = await accepterTacitement();
    expect(bilan.echecs).toBe(0);
    expect(bilan.acceptes).toBeGreaterThanOrEqual(1);

    const detail = await api().get(`${EDL}/${sortie.id}`).set(proprio.h);
    expect(detail.body.data.inspection).toMatchObject({ status: 'accepte', accepted_tacitly: true });
    expect(detail.body.data.inspection.document_id).toBeTruthy();
    expect(detail.body.data.inspection.locked_at).toBeTruthy();
    const [audit] = await sequelize.query(
      "SELECT actor_role, user_id FROM audit_logs WHERE entity_id = :id AND action = 'etat_des_lieux.changement_statut' ORDER BY created_at DESC LIMIT 1",
      { replacements: { id: sortie.id }, type: QueryTypes.SELECT }
    );
    expect(audit).toEqual({ actor_role: 'systeme', user_id: null });
    // Déjà acceptés : un second passage ne fait rien.
    expect(await accepterTacitement()).toEqual({ acceptes: 0, echecs: 0 });
  });

  test('suppression d’un premier brouillon', async () => {
    const proprio = await nouveauProprietaire();
    const autre = await nouveauBail(proprio, { type: 'local_commercial' });
    const creation = await api().post(EDL).set(proprio.h).send({ lease_id: autre.lease.id, type: 'entree' });
    expect(creation.body.data.inspection.rooms.map((r) => r.name)).toEqual(['Local principal', 'Réserve', 'Sanitaires']);
    const id = creation.body.data.inspection.id;
    expect((await api().post(`${EDL}/${id}/soumettre`).set(autreProprio.h).send({})).status).toBe(403);
    expect((await api().delete(`${EDL}/${id}`).set(proprio.h)).status).toBe(200);
    expect((await api().get(`${EDL}/${id}`).set(proprio.h)).status).toBe(404);
  });
});
