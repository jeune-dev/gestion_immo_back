'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, bailActif, activerLocataire, pngTest, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const { INCIDENT } = require('../../../../config/transitions.js');

/**
 * Incidents (§ 22) et workflow (§ 23) — routes propriétaire /incidents et
 * locataire /locataire/incidents (montées par routes.js) : parcours complet de
 * bout en bout, matrice des transitions, validation, pagination, filtres,
 * cloisonnement entre locataires et propriétaires, concurrence.
 */

jest.setTimeout(120000);

const I = '/api/v1/incidents';
const L = '/api/v1/locataire/incidents';
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
/** En-tête MP4 minimal (boîte ftyp « isom ») : reconnu par signature binaire. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);

afterAll(fermer);

describe('Incidents — couverture complète', () => {
  let p;
  let autre;
  let bail;
  let loc;
  let bail2;
  let loc2;

  const signaler = (session = loc, surcharges = {}) => api().post(L).set(session.h)
    .send({ category: 'plomberie', title: 'Évier bouché', description: 'L’eau ne s’écoule plus', ...surcharges });
  const nouvelIncident = async (surcharges = {}) => {
    const res = await signaler(loc, surcharges);
    expect(res.status).toBe(201);
    return res.body.data.incident;
  };
  const notifs = (userId, filtre = '') => q(`SELECT type, title, data FROM notifications WHERE user_id = :u ${filtre} ORDER BY created_at, id`, { u: userId });

  beforeAll(async () => {
    p = await nouveauProprietaire();
    autre = await nouveauProprietaire();
    bail = await bailActif(p);
    loc = await activerLocataire(p, bail.tenant);
    bail2 = await bailActif(p);
    loc2 = await activerLocataire(p, bail2.tenant);
  });

  describe('§ 23 — parcours de bout en bout', () => {
    test('signalement → analyse → travaux → intervention (photos, dépense) → terminé ⇒ incident résolu, locataire informé à chaque étape', async () => {
      // 1-2. Signalement ; le propriétaire est notifié.
      const inc = await nouvelIncident({ category: 'fuite', title: 'Fuite chauffe-eau' });
      expect(inc).toMatchObject({ status: 'signale', reference: expect.stringMatching(/^INC-\d{4}-\d{5}$/), apartment: { id: bail.apartment.id } });
      expect(inc.owner_id).toBeUndefined();
      expect((await notifs(p.user.id, "AND type = 'incident'")).some((n) => n.data.incident_id === inc.id)).toBe(true);

      // 3. Analyse, avec note interne jamais montrée au locataire.
      const analyse = await api().post(`${I}/${inc.id}/analyser`).set(p.h).send({ note: 'Note interne : vérifier la garantie' });
      expect(analyse.status).toBe(200);
      expect(analyse.body.data.incident).toMatchObject({ status: 'en_analyse', owner_note: 'Note interne : vérifier la garantie' });
      expect(analyse.body.data.incident.analysed_at).not.toBeNull();

      // 4. Travaux depuis l'incident : repris de l'incident, « validé », incident « travaux planifiés ».
      const artisan = (await api().post('/api/v1/artisans').set(p.h).send({ name: 'Plombier du quartier', trade: 'plombier' })).body.data.contractor;
      const tr = await api().post(`${I}/${inc.id}/travaux`).set(p.h).send({ contractor_id: artisan.id, estimated_amount: 60000 });
      expect(tr.status).toBe(201);
      const wo = tr.body.data.work_order;
      expect(wo).toMatchObject({
        status: 'valide', incident_id: inc.id, building_id: bail.building.id, apartment_id: bail.apartment.id,
        title: 'Fuite chauffe-eau', category: 'plomberie', estimated_amount: 60000, contractor: { id: artisan.id },
      });
      expect(wo.events[0].comment).toBe(`Créé depuis l'incident ${inc.reference}`);

      // 5-7. Intervention, photos, dépense.
      for (const s of [{ status: 'artisan_assigne' }, { status: 'en_cours' }]) {
        expect((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send(s)).status).toBe(200);
      }
      expect((await api().post(`/api/v1/travaux/${wo.id}/photos`).set(p.h).field('phase', 'avant').attach('fichier', await pngTest(), 'a.png')).status).toBe(201);
      expect((await api().post(`/api/v1/travaux/${wo.id}/depenses`).set(p.h).send({ amount: 58000, method: 'wave', spent_on: '2026-09-25' })).status).toBe(201);

      // 8. Travail terminé ⇒ incident résolu, locataire notifié « travail terminé ».
      expect((await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'termine', actual_amount: 58000 })).status).toBe(200);
      const fin = (await api().get(`${I}/${inc.id}`).set(p.h)).body.data.incident;
      expect(fin).toMatchObject({ status: 'resolu', work_orders: [expect.objectContaining({ id: wo.id, status: 'termine', actual_amount: 58000 })] });
      expect(fin.resolved_at).not.toBeNull();

      const recus = await notifs(loc.user.id, `AND data->>'incident_id' = '${inc.id}'`);
      expect(recus.map((n) => n.data.status)).toEqual(['en_analyse', 'travaux_planifies', 'resolu']);
      expect(recus[2].type).toBe('travail_termine');

      // Vue locataire : suivi sans note interne ni montants.
      const vue = await api().get(`${L}/${inc.id}`).set(loc.h);
      expect(vue.status).toBe(200);
      expect(vue.body.data.incident).toMatchObject({ status: 'resolu', work_orders: [expect.objectContaining({ id: wo.id, status: 'termine' })] });
      const brut = JSON.stringify(vue.body);
      expect(brut).not.toMatch(/owner_note|Note interne|actual_amount|estimated_amount|58000|owner_id|reported_by/);

      // Journal d'audit : chaque transition.
      const audit = await q("SELECT details->>'apres' AS apres FROM audit_logs WHERE entity_id = :id AND action = 'incident.changement_statut' ORDER BY created_at", { id: inc.id });
      expect(audit.map((a) => a.apres)).toEqual(['en_analyse', 'travaux_planifies', 'resolu']);
    });

    test('deux chantiers pour un incident : résolu seulement quand le DERNIER est clos ; annulé seul → retour « en analyse »', async () => {
      const inc = await nouvelIncident();
      const w1 = (await api().post(`${I}/${inc.id}/travaux`).set(p.h).send({ title: 'Chantier 1' })).body.data.work_order;
      const w2 = (await api().post(`${I}/${inc.id}/travaux`).set(p.h).send({ title: 'Chantier 2', status: 'signale' })).body.data.work_order;
      expect(w2.status).toBe('signale');
      await api().post(`/api/v1/travaux/${w1.id}/statut`).set(p.h).send({ status: 'en_cours' });
      await api().post(`/api/v1/travaux/${w1.id}/statut`).set(p.h).send({ status: 'termine' });
      expect((await q('SELECT status FROM incidents WHERE id = :id', { id: inc.id }))[0].status).toBe('travaux_planifies');
      await api().post(`/api/v1/travaux/${w2.id}/statut`).set(p.h).send({ status: 'annule', comment: 'Inutile' });
      // Un chantier a abouti : résolu.
      expect((await q('SELECT status FROM incidents WHERE id = :id', { id: inc.id }))[0].status).toBe('resolu');

      const seul = await nouvelIncident();
      const w = (await api().post(`${I}/${seul.id}/travaux`).set(p.h).send({})).body.data.work_order;
      await api().post(`/api/v1/travaux/${w.id}/statut`).set(p.h).send({ status: 'annule', comment: 'Devis refusé' });
      expect((await q('SELECT status FROM incidents WHERE id = :id', { id: seul.id }))[0].status).toBe('en_analyse');
    });
  });

  describe('G — matrice des transitions (§ 23)', () => {
    const ACTIONS = {
      analyser: { vers: 'en_analyse', corps: {} },
      rejeter: { vers: 'rejete', corps: { reason: 'Hors bail' } },
      resoudre: { vers: 'resolu', corps: { note: 'Réglé' } },
      travaux: { vers: 'travaux_planifies', corps: {} },
    };
    const cas = [];
    for (const de of Object.keys(INCIDENT)) {
      for (const [action, { vers }] of Object.entries(ACTIONS)) {
        // « travaux » sur un incident déjà planifié : second chantier, sans transition.
        const permise = INCIDENT[de].includes(vers) || (action === 'travaux' && de === 'travaux_planifies');
        cas.push([de, action, permise]);
      }
    }

    test.each(cas)('depuis « %s », action « %s » : permise = %s', async (de, action, permise) => {
      const inc = await nouvelIncident();
      await q('UPDATE incidents SET status = :s WHERE id = :id', { s: de, id: inc.id });
      const avantWo = await compter('work_orders', 'incident_id = :id', { id: inc.id });
      const res = await api().post(`${I}/${inc.id}/${action}`).set(p.h).send(ACTIONS[action].corps);
      const [apres] = await q('SELECT status FROM incidents WHERE id = :id', { id: inc.id });
      if (permise) {
        expect([200, 201]).toContain(res.status);
        expect(apres.status).toBe(ACTIONS[action].vers);
      } else {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('TRANSITION_INVALIDE');
        expect(apres.status).toBe(de);
        // Refus = aucun chantier créé (transaction annulée).
        expect(await compter('work_orders', 'incident_id = :id', { id: inc.id })).toBe(avantWo);
      }
    });

    test('rejet : motif obligatoire (422) puis conservé et envoyé au locataire', async () => {
      const inc = await nouvelIncident();
      expect((await api().post(`${I}/${inc.id}/rejeter`).set(p.h).send({})).status).toBe(422);
      expect((await api().post(`${I}/${inc.id}/rejeter`).set(p.h).send({ reason: 'ok' })).status).toBe(422);
      const res = await api().post(`${I}/${inc.id}/rejeter`).set(p.h).send({ reason: 'Entretien à la charge du locataire' });
      expect(res.body.data.incident).toMatchObject({ status: 'rejete', rejection_reason: 'Entretien à la charge du locataire' });
      const [n] = await notifs(loc.user.id, `AND data->>'incident_id' = '${inc.id}'`);
      expect(n.title).toMatch(/Rejeté|rejet/i);
    });

    test('analyses simultanées → une seule transition, un seul audit, une seule notification', async () => {
      const inc = await nouvelIncident();
      const reponses = await Promise.all([1, 2, 3].map(() => api().post(`${I}/${inc.id}/analyser`).set(p.h).send({})));
      expect(reponses.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await compter('audit_logs', "entity_id = :id AND action = 'incident.changement_statut'", { id: inc.id })).toBe(1);
      expect((await notifs(loc.user.id, `AND data->>'incident_id' = '${inc.id}'`))).toHaveLength(1);
    });

    test('« créer les travaux » simultanés sur un incident signalé → chantiers cohérents, une seule transition', async () => {
      const inc = await nouvelIncident();
      const reponses = await Promise.all([1, 2].map(() => api().post(`${I}/${inc.id}/travaux`).set(p.h).send({})));
      expect(reponses.every((r) => r.status === 201)).toBe(true);
      expect(await compter('work_orders', 'incident_id = :id', { id: inc.id })).toBe(2);
      expect(await compter('audit_logs', "entity_id = :id AND action = 'incident.changement_statut'", { id: inc.id })).toBe(1);
    });
  });

  describe('espace locataire', () => {
    test('signalement : bail et logement déduits, champs protégés ignorés, audit ; validation 422', async () => {
      const res = await signaler(loc, { status: 'resolu', owner_id: autre.ownerId, building_id: crypto.randomUUID(), owner_note: 'x' });
      expect(res.status).toBe(201);
      const [ligne] = await q('SELECT * FROM incidents WHERE id = :id', { id: res.body.data.incident.id });
      expect(ligne).toMatchObject({
        status: 'signale', owner_id: p.ownerId, tenant_id: bail.tenant.id, lease_id: bail.lease.id,
        building_id: bail.building.id, apartment_id: bail.apartment.id, owner_note: null, reported_by: loc.user.id,
      });
      expect(await compter('audit_logs', "action = 'incident.creation' AND entity_id = :id", { id: ligne.id })).toBe(1);

      for (const envoi of [
        {}, { category: 'x', title: 'Titre', description: 'Description' }, { category: 'fuite', title: 'x', description: 'Description' },
        { category: 'fuite', title: 'x'.repeat(151), description: 'Description' }, { category: 'fuite', title: 'Titre', description: 'x' },
        { category: 'fuite', title: 'Titre', description: 'x'.repeat(5001) }, { category: 'fuite', title: 'Titre', description: 'Description', lease_id: 'x' },
        { category: 'fuite', title: 'Titre', description: 'Description', client_reference: 'court' },
      ]) {
        expect([envoi, (await api().post(L).set(loc.h).send(envoi)).status]).toEqual([envoi, 422]);
      }
      // Bail d'un autre locataire → 422 BAIL_INVALIDE.
      const res2 = await signaler(loc, { lease_id: bail2.lease.id });
      expect(res2.status).toBe(422);
      expect(res2.body.error.code).toBe('BAIL_INVALIDE');
    });

    test('client_reference : renvoi → 200 même demande ; envois SIMULTANÉS → une seule demande', async () => {
      const ref = `hors-ligne-${crypto.randomBytes(5).toString('hex')}`;
      const r1 = await signaler(loc, { client_reference: ref });
      const r2 = await signaler(loc, { client_reference: ref });
      expect([r1.status, r2.status]).toEqual([201, 200]);
      expect(r2.body.data.incident.id).toBe(r1.body.data.incident.id);

      const ref2 = `concurrent-${crypto.randomBytes(5).toString('hex')}`;
      const reponses = await Promise.all([1, 2, 3].map(() => signaler(loc, { client_reference: ref2 })));
      expect(reponses.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(new Set(reponses.map((r) => r.body.data.incident.id)).size).toBe(1);
      expect(await compter('incidents', 'client_reference = :r', { r: ref2 })).toBe(1);
    });

    test('« Mes demandes » : les siennes seulement, filtre statut, pagination ; 422 si invalide', async () => {
      const mien = await nouvelIncident();
      const sien = (await signaler(loc2)).body.data.incident;
      const liste = await api().get(L).query({ limit: 100 }).set(loc.h);
      expect(liste.status).toBe(200);
      const ids = liste.body.data.items.map((x) => x.id);
      expect(ids).toContain(mien.id);
      expect(ids).not.toContain(sien.id);
      expect(liste.body.data.pagination.total).toBe(await compter('incidents', 'tenant_id = :t', { t: bail.tenant.id }));
      expect(JSON.stringify(liste.body)).not.toMatch(/owner_note|owner_id|reported_by/);
      await api().post(`${I}/${mien.id}/rejeter`).set(p.h).send({ reason: 'Filtre de test' });
      expect((await api().get(L).query({ status: 'rejete' }).set(loc.h)).body.data.items.map((x) => x.id)).toContain(mien.id);
      const page = await api().get(L).query({ limit: 1, page: 2 }).set(loc.h);
      expect(page.body.data.items).toHaveLength(1);
      expect((await api().get(L).query({ limit: 1000 }).set(loc.h)).body.data.pagination.limit).toBe(100);
      for (const query of [{ status: 'x' }, { page: 0 }, { limit: 0 }]) expect((await api().get(L).query(query).set(loc.h)).status).toBe(422);
      // Demande d'un autre locataire : 403 ; inconnue : 404 ; id invalide : 422.
      expect((await api().get(`${L}/${sien.id}`).set(loc.h)).status).toBe(403);
      expect((await api().get(`${L}/${crypto.randomUUID()}`).set(loc.h)).status).toBe(404);
      expect((await api().get(`${L}/abc`).set(loc.h)).status).toBe(422);
    });

    test('pièces : photo et vidéo acceptées (partagées avec le locataire), PDF / contenu déguisé refusés ; closes après planification', async () => {
      const inc = await nouvelIncident();
      const photo = await api().post(`${L}/${inc.id}/pieces`).set(loc.h).attach('fichier', await pngTest(), 'fuite.png');
      expect(photo.status).toBe(201);
      expect(photo.body.data.document).toMatchObject({ category: 'photo', mime_type: 'image/png' });
      const video = await api().post(`${L}/${inc.id}/pieces`).set(loc.h).attach('fichier', MP4, 'fuite.mp4');
      expect(video.status).toBe(201);
      expect(video.body.data.document).toMatchObject({ category: 'video', mime_type: 'video/mp4' });
      const docs = await q("SELECT tenant_id, visible_to_tenant, owner_id FROM documents WHERE entity_type = 'incident' AND entity_id = :id", { id: inc.id });
      expect(docs).toHaveLength(2);
      expect(docs.every((d) => d.tenant_id === bail.tenant.id && d.visible_to_tenant && d.owner_id === p.ownerId)).toBe(true);
      expect((await api().post(`${L}/${inc.id}/pieces`).set(loc.h).attach('fichier', Buffer.from('%PDF-1.4\n%%EOF\n trailer'), 'x.pdf')).status).toBe(400);
      expect((await api().post(`${L}/${inc.id}/pieces`).set(loc.h).attach('fichier', Buffer.from('<?php system($_GET[1]); ?>'), 'x.png')).status).toBe(400);
      expect((await api().post(`${L}/${inc.id}/pieces`).set(loc2.h).attach('fichier', await pngTest(), 'x.png')).status).toBe(403);
      // Le détail locataire les liste.
      expect((await api().get(`${L}/${inc.id}`).set(loc.h)).body.data.incident.documents).toHaveLength(2);
      await api().post(`${I}/${inc.id}/travaux`).set(p.h).send({});
      const refus = await api().post(`${L}/${inc.id}/pieces`).set(loc.h).attach('fichier', await pngTest(), 'tard.png');
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('INCIDENT_PIECES_CLOSES');
      expect(await compter('documents', "entity_type = 'incident' AND entity_id = :id", { id: inc.id })).toBe(2);
    });

    test('locataire sans bail actif : signalement refusé (422 AUCUN_BAIL_ACTIF)', async () => {
      const proprio = await nouveauProprietaire();
      const b = await bailActif(proprio);
      const l = await activerLocataire(proprio, b.tenant);
      await q("UPDATE leases SET status = 'termine', ended_on = '2026-09-10' WHERE id = :id", { id: b.lease.id });
      const res = await signaler(l);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('AUCUN_BAIL_ACTIF');
    });
  });

  describe('espace propriétaire', () => {
    test('incident de partie commune : 201 sans locataire, audit ; validation 422 ; appartement hors immeuble 422 ; références d’autrui 403', async () => {
      const bat = await creerImmeuble(p);
      const apt = await creerAppartement(p, bat.id);
      const res = await api().post(I).set(p.h).send({ building_id: bat.id, apartment_id: apt.id, category: 'probleme_commun', title: 'Ascenseur en panne', description: 'Bloqué au 3e' });
      expect(res.status).toBe(201);
      expect(res.body.data.incident).toMatchObject({ tenant_id: null, lease_id: null, status: 'signale', building: { id: bat.id }, apartment: { id: apt.id } });
      expect(await compter('audit_logs', "action = 'incident.creation' AND entity_id = :id", { id: res.body.data.incident.id })).toBe(1);
      const base = { building_id: bat.id, category: 'autre', title: 'Titre valide', description: 'Description valide' };
      for (const envoi of [{}, { ...base, building_id: undefined }, { ...base, category: 'x' }, { ...base, title: 'x' }, { ...base, description: undefined }, { ...base, building_id: crypto.randomUUID() }, { ...base, apartment_id: bail.apartment.id }]) {
        for (const [k, v] of Object.entries(envoi)) if (v === undefined) delete envoi[k];
        expect([envoi, (await api().post(I).set(p.h).send(envoi)).status]).toEqual([envoi, 422]);
      }
      const batAutre = await creerImmeuble(autre);
      expect((await api().post(I).set(p.h).send({ ...base, building_id: batAutre.id })).status).toBe(403);
    });

    test('travaux depuis l’incident : immeuble différent 422 ; surcharges ; validation', async () => {
      const inc = await nouvelIncident();
      expect((await api().post(`${I}/${inc.id}/travaux`).set(p.h).send({ building_id: bail2.building.id })).status).toBe(422);
      expect((await api().post(`${I}/${inc.id}/travaux`).set(p.h).send({ status: 'termine' })).status).toBe(422);
      expect((await api().post(`${I}/${inc.id}/travaux`).set(p.h).send({ priority: 'x' })).status).toBe(422);
      expect((await q('SELECT status FROM incidents WHERE id = :id', { id: inc.id }))[0].status).toBe('signale');
      const res = await api().post(`${I}/${inc.id}/travaux`).set(p.h).send({ title: 'Titre surchargé', category: 'electricite', apartment_id: null, priority: 'urgente', note: 'Urgent' });
      expect(res.status).toBe(201);
      expect(res.body.data.work_order).toMatchObject({ title: 'Titre surchargé', category: 'electricite', apartment_id: null, priority: 'urgente' });
      expect((await q('SELECT owner_note FROM incidents WHERE id = :id', { id: inc.id }))[0].owner_note).toBe('Urgent');
    });

    test('liste : filtres statut, catégorie, immeuble, appartement, locataire, période, recherche ; tri ; pagination ; 422', async () => {
      const proprio = await nouveauProprietaire();
      const b = await bailActif(proprio);
      const l = await activerLocataire(proprio, b.tenant);
      const mk = (s) => api().post(L).set(l.h).send({ category: s.category, title: s.title, description: 'Description' }).then((r) => r.body.data.incident);
      const i1 = await mk({ category: 'fuite', title: 'Fuite 100% garantie' });
      const i2 = await mk({ category: 'serrure', title: 'Serrure_bloquée' });
      const bat = await creerImmeuble(proprio);
      const i3 = (await api().post(I).set(proprio.h).send({ building_id: bat.id, category: 'probleme_commun', title: 'Portail', description: 'Cassé' })).body.data.incident;
      await api().post(`${I}/${i2.id}/analyser`).set(proprio.h).send({});
      const ids = async (query) => (await api().get(I).query(query).set(proprio.h)).body.data.items.map((x) => x.id).sort();
      expect(await ids({ status: 'en_analyse' })).toEqual([i2.id]);
      expect(await ids({ category: 'fuite' })).toEqual([i1.id]);
      expect(await ids({ building_id: bat.id })).toEqual([i3.id]);
      expect(await ids({ apartment_id: b.apartment.id })).toEqual([i1.id, i2.id].sort());
      expect(await ids({ tenant_id: b.tenant.id })).toEqual([i1.id, i2.id].sort());
      expect(await ids({ q: '100%' })).toEqual([i1.id]);
      expect(await ids({ q: 'e_b' })).toEqual([i2.id]);
      expect(await ids({ q: i3.reference })).toEqual([i3.id]);
      expect(await ids({ au: '2000-01-01' })).toEqual([]);
      for (const terme of ["'; DROP TABLE incidents; --", "' OR 1=1 --", '%']) {
        const res = await api().get(I).query({ q: terme }).set(proprio.h);
        expect(res.status).toBe(200);
        expect(res.body.data.items.every((x) => x.owner_id === proprio.ownerId)).toBe(true);
      }
      const tri = (await api().get(I).query({ tri: 'reference' }).set(proprio.h)).body.data.items.map((x) => x.reference);
      expect(tri).toEqual([...tri].sort());
      const p2 = await api().get(I).query({ limit: 2, page: 2, tri: 'reference' }).set(proprio.h);
      expect(p2.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect(p2.body.data.items).toHaveLength(1);
      expect(p2.body.data.items[0].tenant === null || p2.body.data.items[0].tenant.id === b.tenant.id).toBe(true);
      for (const query of [{ tri: 'title' }, { status: 'x' }, { category: 'x' }, { page: 0 }, { limit: 0 }, { du: '2026-02-31' }, { tenant_id: 'x' }]) {
        expect([query, (await api().get(I).query(query).set(proprio.h)).status]).toEqual([query, 422]);
      }
    });

    test('cloisonnement : autre propriétaire 403 sur chaque route (incident inchangé) ; inconnu 404 ; id invalide 422', async () => {
      const inc = await nouvelIncident();
      const [avant] = await q('SELECT * FROM incidents WHERE id = :id', { id: inc.id });
      for (const r of await Promise.all([
        api().get(`${I}/${inc.id}`).set(autre.h),
        api().post(`${I}/${inc.id}/analyser`).set(autre.h).send({}),
        api().post(`${I}/${inc.id}/rejeter`).set(autre.h).send({ reason: 'Pirate' }),
        api().post(`${I}/${inc.id}/resoudre`).set(autre.h).send({}),
        api().post(`${I}/${inc.id}/travaux`).set(autre.h).send({}),
      ])) expect(r.status).toBe(403);
      expect((await q('SELECT * FROM incidents WHERE id = :id', { id: inc.id }))[0]).toEqual(avant);
      expect(await compter('work_orders', 'incident_id = :id', { id: inc.id })).toBe(0);
      expect((await api().get(I).set(autre.h)).body.data.items.map((x) => x.id)).not.toContain(inc.id);
      expect((await api().post(`${I}/${crypto.randomUUID()}/analyser`).set(p.h).send({})).status).toBe(404);
      expect((await api().post(`${I}/abc/analyser`).set(p.h).send({})).status).toBe(422);
      expect((await api().post(`${I}/${inc.id}/analyser`).set(p.h).send({ note: 'x'.repeat(2001) })).status).toBe(422);
    });
  });
});
