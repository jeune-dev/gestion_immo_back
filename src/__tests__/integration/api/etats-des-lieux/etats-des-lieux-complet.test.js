'use strict';

const fs = require('fs');
const path = require('path');
const {
  api, nouveauProprietaire, superAdmin, bailActif, activerLocataire, proprietaireEtLocataire, pngTest,
  fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const { InspectionPhoto } = require('../../../../models/index.js');
const storage = require('../../../../infrastructure/storage.service.js');
const { accepterTacitement } = require('../../../../modules/etatDesLieux/service/etatDesLieux.service.js');
const {
  UUID_INCONNU, jetonsDegrades, verifierMatrice, verifierStatuts, proprietaireSansPermission,
} = require('../baux/securite.outils.js');

/**
 * États des lieux (§ 52) — TOUTES les routes, propriétaire et locataire :
 * saisie (pièces, éléments, photos, saisie groupée), cycle soumis → accepté /
 * contesté → corrigé, immuabilité de l'état accepté (§ 52.4 : chaque écriture
 * → 409), nouvelle version tracée, AUDIT #15 (photos d'un brouillon cachées
 * au locataire), transactions sans orphelin, concurrence, sécurité.
 */

const EDL = '/api/v1/etats-des-lieux';
const LOC = '/api/v1/locataire/etats-des-lieux';

const elements = (edl) => edl.rooms.flatMap((r) => r.items);
const fichiersDe = (ownerId) => {
  const dossier = path.join(storage.UPLOAD_DIR, 'owners', ownerId);
  return fs.existsSync(dossier) ? fs.readdirSync(dossier, { recursive: true }).filter((f) => fs.statSync(path.join(dossier, f)).isFile()) : [];
};

/** Propriétaire + bail actif + locataire activé + état des lieux (sortie) en brouillon. */
async function brouillonSortie(appartement = {}) {
  const d = await proprietaireEtLocataire({ appartement });
  const res = await api().post(EDL).set(d.proprio.h).send({ lease_id: d.lease.id, type: 'sortie' });
  if (res.status !== 201) throw new Error(`EDL : ${res.status} ${JSON.stringify(res.body)}`);
  return { ...d, p: d.proprio, edl: res.body.data.inspection };
}

const photo = async (p, edlId, itemId, extra = {}) => {
  const req = api().post(`${EDL}/${edlId}/elements/${itemId}/photos`).set(p.h);
  if (extra.captured_at) req.field('captured_at', extra.captured_at);
  return req.attach('fichier', extra.contenu || await pngTest('#321'), extra.nom || 'p.png');
};

describe('États des lieux — API complète (§ 52)', () => {
  afterAll(fermer);

  describe('création et lecture', () => {
    test('trame proposée selon le type d’appartement (studio, villa, bureau, chambre)', async () => {
      const attendus = {
        studio: ['Pièce principale', 'Cuisine', "Salle d'eau / WC"],
        chambre: ['Chambre', "Salle d'eau / WC"],
        // Bureau sans nombre de pièces : 2 par défaut, chaque bureau inspecté séparément.
        bureau: ['Local principal', 'Bureau 2', 'Réserve', 'Sanitaires'],
      };
      const p = await nouveauProprietaire();
      for (const [type, pieces] of Object.entries(attendus)) {
        const { lease } = await bailActif(p, { appartement: { type } });
        const res = await api().post(EDL).set(p.h).send({ lease_id: lease.id, type: 'sortie' });
        expect(res.status).toBe(201);
        expect(res.body.data.inspection.rooms.map((r) => r.name)).toEqual(pieces);
        expect(elements(res.body.data.inspection).every((i) => i.condition === 'bon' && i.photos.length === 0)).toBe(true);
      }
      const { lease } = await bailActif(p, { appartement: { type: 'villa' } });
      const villa = await api().post(EDL).set(p.h).send({ lease_id: lease.id, type: 'sortie' });
      expect(villa.body.data.inspection.rooms.map((r) => r.name)).toEqual(['Salon / Séjour', 'Chambre 1', 'Chambre 2', 'Chambre 3', 'Chambre 4', 'Cuisine', 'Salle de bain', 'WC', 'Balcon / Terrasse']);
    });

    test('création : validation 422, bail d’autrui 403, bail absent 422, bail annulé 409, référence hors ligne rejouée', async () => {
      const { proprio: p, lease } = await proprietaireEtLocataire();
      const autre = await bailActif(await nouveauProprietaire());
      const ecarts = await verifierStatuts([
        ['post', EDL, {}, 422],
        ['post', EDL, { type: 'sortie' }, 422],
        ['post', EDL, { lease_id: lease.id }, 422],
        ['post', EDL, { lease_id: lease.id, type: 'inventaire' }, 422],
        ['post', EDL, { lease_id: 'abc', type: 'sortie' }, 422],
        ['post', EDL, { lease_id: lease.id, type: 'sortie', client_reference: 'espace interdit' }, 422],
        ['post', EDL, { lease_id: lease.id, type: 'sortie', client_reference: 'x'.repeat(65) }, 422],
        ['post', EDL, { lease_id: lease.id, type: 'sortie', parties_present: [{ name: '', role: 'x' }] }, 422],
        ['post', EDL, { lease_id: lease.id, type: 'sortie', parties_present: Array.from({ length: 11 }, () => ({ name: 'A', role: 'B' })) }, 422],
        ['post', EDL, { lease_id: lease.id, type: 'sortie', performed_at: 'pas une date' }, 422],
        ['post', EDL, { lease_id: UUID_INCONNU, type: 'sortie' }, 422],
        ['post', EDL, { lease_id: autre.lease.id, type: 'sortie' }, 403],
      ], p.h);
      expect(ecarts).toEqual([]);
      expect(await compter('inspections', 'lease_id = :l', { l: lease.id })).toBe(0);

      const premier = await api().post(EDL).set(p.h).send({ lease_id: lease.id, type: 'sortie', client_reference: 'mobile-sortie-001' });
      const rejeu = await api().post(EDL).set(p.h).send({ lease_id: lease.id, type: 'sortie', client_reference: 'mobile-sortie-001' });
      expect([premier.status, rejeu.status]).toEqual([201, 201]);
      expect(rejeu.body.data.inspection.id).toBe(premier.body.data.inspection.id);
      expect(await compter('inspections', 'lease_id = :l', { l: lease.id })).toBe(1);
      expect(await compter('audit_logs', "action = 'etat_des_lieux.creation' AND entity_id = :id", { id: premier.body.data.inspection.id })).toBe(1);

      const annule = await api().post('/api/v1/baux').set(p.h).send({ apartment_id: (await bailActif(p)).apartment.id, tenant_id: lease.tenant_id, start_date: '2027-01-01' });
      await api().post(`/api/v1/baux/${annule.body.data.lease.id}/annuler`).set(p.h).send({ reason: 'Abandon' });
      const refus = await api().post(EDL).set(p.h).send({ lease_id: annule.body.data.lease.id, type: 'entree' });
      expect(refus.status).toBe(409);
      expect(refus.body.error.code).toBe('BAIL_STATUT_INCOMPATIBLE');
    });

    test('liste : vide, filtres (bail, appartement, locataire, type, statut), tri, pagination ; paramètres invalides 422', async () => {
      const p = await nouveauProprietaire();
      expect((await api().get(EDL).set(p.h)).body.data.items).toEqual([]);
      const b1 = await bailActif(p);
      const b2 = await bailActif(p);
      const e1 = (await api().post(EDL).set(p.h).send({ lease_id: b1.lease.id, type: 'sortie' })).body.data.inspection;
      const e2 = (await api().post(EDL).set(p.h).send({ lease_id: b2.lease.id, type: 'sortie' })).body.data.inspection;
      await api().post(`${EDL}/${e2.id}/soumettre`).set(p.h).send({});
      const ids = async (q) => (await api().get(`${EDL}?${q}`).set(p.h)).body.data.items.map((i) => i.id);
      expect(await ids(`lease_id=${b1.lease.id}`)).toEqual([e1.id]);
      expect(await ids(`apartment_id=${b2.apartment.id}`)).toEqual([e2.id]);
      expect(await ids(`tenant_id=${b1.tenant.id}`)).toEqual([e1.id]);
      expect(await ids('status=soumis')).toEqual([e2.id]);
      expect(await ids('type=entree')).toEqual([]);
      expect(await ids('tri=created_at')).toEqual([e1.id, e2.id]);
      expect(await ids('tri=-created_at')).toEqual([e2.id, e1.id]);
      const page2 = await api().get(`${EDL}?limit=1&page=2`).set(p.h);
      expect(page2.body.data.pagination).toMatchObject({ total: 2, totalPages: 2, page: 2 });
      expect(page2.body.data.items).toHaveLength(1);
      expect((await api().get(`${EDL}?limit=1000`).set(p.h)).body.data.pagination.limit).toBe(100);
      const liste = (await api().get(EDL).set(p.h)).body.data.items[0];
      expect(liste).toHaveProperty('lease.reference');
      expect(liste).toHaveProperty('apartment.number');
      const ecarts = await verifierStatuts([
        ['get', `${EDL}?page=0`, undefined, 422],
        ['get', `${EDL}?limit=0`, undefined, 422],
        ['get', `${EDL}?limit=-3`, undefined, 422],
        ['get', `${EDL}?status=inconnu`, undefined, 422],
        ['get', `${EDL}?type=inventaire`, undefined, 422],
        ['get', `${EDL}?tri=owner_id`, undefined, 422],
        ['get', `${EDL}?lease_id=${encodeURIComponent('%; DROP')}`, undefined, 422],
      ], p.h);
      expect(ecarts).toEqual([]);
    });
  });

  describe('saisie du brouillon', () => {
    test('en-tête : compteurs, clés, parties, observations ; validation ; audit', async () => {
      const { p, edl } = await brouillonSortie();
      const res = await api().patch(`${EDL}/${edl.id}`).set(p.h).send({
        water_meter: 10.5, electricity_meter: 2000, keys_count: 2, keys_details: 'Deux clés', general_observations: 'RAS',
        parties_present: [{ name: 'Awa Sarr', role: 'mandataire' }], performed_at: '2026-11-30T09:00:00Z', status: 'accepte',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.inspection).toMatchObject({ keys_count: 2, status: 'brouillon', parties_present: [{ name: 'Awa Sarr', role: 'mandataire' }] });
      expect(await compter('audit_logs', "action = 'etat_des_lieux.modification' AND entity_id = :id", { id: edl.id })).toBe(1);
      const u = `${EDL}/${edl.id}`;
      const ecarts = await verifierStatuts([
        ['patch', u, {}, 422],
        ['patch', u, { keys_count: -1 }, 422],
        ['patch', u, { keys_count: 1.5 }, 422],
        ['patch', u, { water_meter: -2 }, 422],
        ['patch', u, { electricity_meter: 'beaucoup' }, 422],
        ['patch', u, { general_observations: 'x'.repeat(5001) }, 422],
        ['patch', u, { parties_present: 'Awa' }, 422],
        ['patch', `${EDL}/${UUID_INCONNU}`, { keys_count: 1 }, 404],
        ['patch', `${EDL}/abc`, { keys_count: 1 }, 422],
      ], p.h);
      expect(ecarts).toEqual([]);
    });

    test('pièces : ajout (éléments par défaut ou explicites), modification, suppression avec ses photos ; validation ; pièce d’un autre EDL 404', async () => {
      const { p, edl } = await brouillonSortie();
      const autre = await brouillonSortie();
      const ajout = await api().post(`${EDL}/${edl.id}/pieces`).set(p.h).send({ name: 'Cuisine d’été', items: [{ element: 'murs' }, { element: 'plomberie', label: 'Évier' }] });
      expect(ajout.status).toBe(201);
      const room = ajout.body.data.room;
      expect(room.items.map((i) => [i.element, i.label])).toEqual([['murs', null], ['plomberie', 'Évier']]);
      const modif = await api().patch(`${EDL}/${edl.id}/pieces/${room.id}`).set(p.h).send({ name: 'Cuisine extérieure', notes: 'Carrelage neuf' });
      expect(modif.status).toBe(200);
      expect(modif.body.data.room).toMatchObject({ name: 'Cuisine extérieure', notes: 'Carrelage neuf' });

      const ph = await photo(p, edl.id, room.items[0].id);
      expect(ph.status).toBe(201);
      const suppr = await api().delete(`${EDL}/${edl.id}/pieces/${room.id}`).set(p.h);
      expect(suppr.status).toBe(200);
      expect(await compter('inspection_items', 'room_id = :r', { r: room.id })).toBe(0);
      expect(await compter('documents', 'id = :d AND deleted_at IS NOT NULL', { d: ph.body.data.photo.document.id })).toBe(1);

      const piece0 = edl.rooms[0].id;
      const ecarts = await verifierStatuts([
        ['post', `${EDL}/${edl.id}/pieces`, {}, 422],
        ['post', `${EDL}/${edl.id}/pieces`, { name: '' }, 422],
        ['post', `${EDL}/${edl.id}/pieces`, { name: 'x'.repeat(81) }, 422],
        ['post', `${EDL}/${edl.id}/pieces`, { name: 'Cave', position: 501 }, 422],
        ['post', `${EDL}/${edl.id}/pieces`, { name: 'Cave', items: [{ element: 'piscine' }] }, 422],
        ['patch', `${EDL}/${edl.id}/pieces/${piece0}`, {}, 422],
        ['patch', `${EDL}/${edl.id}/pieces/${autre.edl.rooms[0].id}`, { name: 'Vol' }, 404],
        ['delete', `${EDL}/${edl.id}/pieces/${autre.edl.rooms[0].id}`, undefined, 404],
        ['patch', `${EDL}/${edl.id}/pieces/pas-un-uuid`, { name: 'x' }, 422],
      ], p.h);
      expect(ecarts).toEqual([]);
    });

    test('éléments : ajout, modification, suppression ; validation ; élément d’un autre EDL 404', async () => {
      const { p, edl } = await brouillonSortie();
      const autre = await brouillonSortie();
      const room = edl.rooms[0];
      const ajout = await api().post(`${EDL}/${edl.id}/pieces/${room.id}/elements`).set(p.h).send({ element: 'mobilier', label: 'Canapé', condition: 'usage', comment: 'Tache' });
      expect(ajout.status).toBe(201);
      expect(ajout.body.data.item).toMatchObject({ element: 'mobilier', label: 'Canapé', condition: 'usage', comment: 'Tache', photos: [], position: room.items.length });
      const item = ajout.body.data.item;
      const modif = await api().patch(`${EDL}/${edl.id}/elements/${item.id}`).set(p.h).send({ condition: 'degrade', comment: null });
      expect(modif.body.data.item).toMatchObject({ condition: 'degrade', comment: null });
      const autreItem = elements(autre.edl)[0].id;
      const ecarts = await verifierStatuts([
        ['post', `${EDL}/${edl.id}/pieces/${room.id}/elements`, {}, 422],
        ['post', `${EDL}/${edl.id}/pieces/${room.id}/elements`, { element: 'piscine' }, 422],
        ['post', `${EDL}/${edl.id}/pieces/${room.id}/elements`, { element: 'murs', condition: 'neuf' }, 422],
        ['post', `${EDL}/${edl.id}/pieces/${room.id}/elements`, { element: 'murs', comment: 'x'.repeat(2001) }, 422],
        ['post', `${EDL}/${edl.id}/pieces/${autre.edl.rooms[0].id}/elements`, { element: 'murs' }, 404],
        ['patch', `${EDL}/${edl.id}/elements/${item.id}`, {}, 422],
        ['patch', `${EDL}/${edl.id}/elements/${item.id}`, { condition: 'excellent' }, 422],
        ['patch', `${EDL}/${edl.id}/elements/${autreItem}`, { condition: 'bon' }, 404],
        ['delete', `${EDL}/${edl.id}/elements/${autreItem}`, undefined, 404],
      ], p.h);
      expect(ecarts).toEqual([]);
      expect((await api().delete(`${EDL}/${edl.id}/elements/${item.id}`).set(p.h)).status).toBe(200);
      expect(await compter('inspection_items', 'id = :id', { id: item.id })).toBe(0);
      expect((await api().get(`${EDL}/${autre.edl.id}`).set(autre.p.h)).body.data.inspection.rooms[0].items[0].id).toBe(autreItem);
    });

    test('saisie groupée : validation (vide, doublon, état inconnu, élément étranger) sans aucune écriture partielle', async () => {
      const { p, edl } = await brouillonSortie();
      const autre = await brouillonSortie();
      const [i1, i2] = elements(edl);
      const u = `${EDL}/${edl.id}/saisie`;
      const ecarts = await verifierStatuts([
        ['put', u, {}, 422],
        ['put', u, { items: [] }, 422],
        ['put', u, { items: [{ item_id: i1.id, condition: 'bon' }, { item_id: i1.id, condition: 'usage' }] }, 422],
        ['put', u, { items: [{ item_id: i1.id }] }, 422],
        ['put', u, { items: [{ item_id: 'abc', condition: 'bon' }] }, 422],
        ['put', u, { items: [{ item_id: i1.id, condition: 'hors_service' }, { item_id: elements(autre.edl)[0].id, condition: 'hors_service' }] }, 422],
      ], p.h);
      expect(ecarts).toEqual([]);
      const [[etat]] = await sequelize.query('SELECT condition FROM inspection_items WHERE id = :id', { replacements: { id: i1.id } });
      expect(etat.condition).toBe('bon');
      const ok = await api().put(u).set(p.h).send({ items: [{ item_id: i1.id, condition: 'usage', comment: 'Rayé' }, { item_id: i2.id, condition: 'hors_service' }] });
      expect(ok.status).toBe(200);
      expect(elements(ok.body.data.inspection).slice(0, 2).map((i) => [i.condition, i.comment])).toEqual([['usage', 'Rayé'], ['hors_service', null]]);
    });

    test('photos : prise de vue conservée, validation (date, type de fichier), suppression logique, 20 au maximum', async () => {
      const { p, edl } = await brouillonSortie();
      const item = elements(edl)[0];
      const ok = await photo(p, edl.id, item.id, { captured_at: '2026-11-30T08:00:00Z' });
      expect(ok.status).toBe(201);
      expect(ok.body.data.photo).toMatchObject({ item_id: item.id, captured_at: '2026-11-30T08:00:00.000Z' });
      expect((await photo(p, edl.id, item.id, { captured_at: 'demain' })).status).toBe(422);
      const pdf = await photo(p, edl.id, item.id, { contenu: Buffer.from('%PDF-1.4\n%%EOF\n'.padEnd(40, ' ')), nom: 'x.png' });
      expect(pdf.status).toBe(400);
      expect((await photo(p, edl.id, UUID_INCONNU)).status).toBe(404);

      const suppr = await api().delete(`${EDL}/${edl.id}/photos/${ok.body.data.photo.id}`).set(p.h);
      expect(suppr.status).toBe(200);
      expect(await compter('documents', 'id = :d AND deleted_at IS NOT NULL', { d: ok.body.data.photo.document.id })).toBe(1);
      expect((await api().delete(`${EDL}/${edl.id}/photos/${ok.body.data.photo.id}`).set(p.h)).status).toBe(404);

      // 20 photos déjà présentes (insérées directement) : la 21e est refusée.
      await sequelize.query(
        `WITH d AS (
           INSERT INTO documents (owner_id, tenant_id, entity_type, entity_id, category, storage_key, mime_type, size_bytes, visible_to_tenant)
           SELECT :o, :t, 'inspection', :e, 'photo', 'owners/x/photo-' || g, 'image/png', 1, false FROM generate_series(1, 20) g
           RETURNING id)
         INSERT INTO inspection_photos (inspection_id, item_id, document_id) SELECT :e, :i, id FROM d`,
        { replacements: { o: p.ownerId, t: edl.tenant_id, e: edl.id, i: item.id } }
      );
      const avant = fichiersDe(p.ownerId).length;
      const trop = await photo(p, edl.id, item.id);
      expect(trop.status).toBe(409);
      expect(trop.body.error.code).toBe('PHOTOS_TROP_NOMBREUSES');
      expect(fichiersDe(p.ownerId)).toHaveLength(avant);
    });

    test('transaction : panne après l’écriture de la photo → ni document, ni fichier orphelin', async () => {
      const { p, edl } = await brouillonSortie();
      const avant = fichiersDe(p.ownerId).length;
      const espion = jest.spyOn(InspectionPhoto, 'create').mockRejectedValueOnce(new Error('Panne simulée'));
      try {
        expect((await photo(p, edl.id, elements(edl)[0].id)).status).toBe(500);
      } finally {
        espion.mockRestore();
      }
      expect(await compter('documents', "entity_type = 'inspection' AND entity_id = :id", { id: edl.id })).toBe(0);
      expect(fichiersDe(p.ownerId)).toHaveLength(avant);
    });

    test('PDF d’un brouillon (propriétaire) ; suppression d’un brouillon : photos supprimées logiquement ; 404 ensuite', async () => {
      const { p, edl } = await brouillonSortie();
      const pdf = await api().get(`${EDL}/${edl.id}/pdf`).set(p.h).buffer(true).parse((res, cb) => {
        const m = []; res.on('data', (x) => m.push(x)); res.on('end', () => cb(null, Buffer.concat(m)));
      });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['cache-control']).toBe('private, no-store');
      expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
      const ph = await photo(p, edl.id, elements(edl)[0].id);
      expect((await api().delete(`${EDL}/${edl.id}`).set(p.h)).status).toBe(200);
      expect(await compter('documents', 'id = :d AND deleted_at IS NOT NULL', { d: ph.body.data.photo.document.id })).toBe(1);
      expect(await compter('audit_logs', "action = 'etat_des_lieux.suppression' AND entity_id = :id", { id: edl.id })).toBe(1);
      expect((await api().get(`${EDL}/${edl.id}`).set(p.h)).status).toBe(404);
      expect((await api().get(`${EDL}/${edl.id}/pdf`).set(p.h)).status).toBe(404);
    });
  });

  describe('cycle de vie', () => {
    test('AUDIT #15 : photo d’un brouillon invisible du locataire (document et détail), visible après soumission', async () => {
      const { p, locataire, edl } = await brouillonSortie();
      const item = elements(edl)[0];
      const ph = (await photo(p, edl.id, item.id)).body.data.photo;
      expect(ph.document.visible_to_tenant).toBe(false);
      const [[doc]] = await sequelize.query('SELECT visible_to_tenant FROM documents WHERE id = :id', { replacements: { id: ph.document.id } });
      expect(doc.visible_to_tenant).toBe(false);
      expect((await api().get(`/api/v1/documents/${ph.document.id}/fichier`).set(locataire.h)).status).toBe(403);
      expect((await api().get(`${LOC}/${edl.id}`).set(locataire.h)).status).toBe(404);

      const soumis = await api().post(`${EDL}/${edl.id}/soumettre`).set(p.h).send({});
      expect(soumis.status).toBe(200);
      const [[apres]] = await sequelize.query('SELECT visible_to_tenant FROM documents WHERE id = :id', { replacements: { id: ph.document.id } });
      expect(apres.visible_to_tenant).toBe(true);
      const vue = await api().get(`${LOC}/${edl.id}`).set(locataire.h);
      expect(elements(vue.body.data.inspection).find((i) => i.id === item.id).photos.map((x) => x.document.id)).toEqual([ph.document.id]);
      expect((await api().get(`/api/v1/documents/${ph.document.id}/fichier`).set(locataire.h)).status).toBe(200);
    });

    test('soumission : EDL vide 409, double soumission 409, délai paramétrable', async () => {
      const { p, edl } = await brouillonSortie();
      await api().patch('/api/v1/parametres').set(p.h).send({ inspection_response_days: 3 });
      for (const room of edl.rooms) await api().delete(`${EDL}/${edl.id}/pieces/${room.id}`).set(p.h);
      const vide = await api().post(`${EDL}/${edl.id}/soumettre`).set(p.h).send({});
      expect(vide.status).toBe(409);
      expect(vide.body.error.code).toBe('ETAT_DES_LIEUX_VIDE');
      await api().post(`${EDL}/${edl.id}/pieces`).set(p.h).send({ name: 'Séjour' });
      const ok = await api().post(`${EDL}/${edl.id}/soumettre`).set(p.h).send({});
      expect(ok.status).toBe(200);
      const jours = (new Date(ok.body.data.inspection.response_deadline) - new Date(ok.body.data.inspection.submitted_at)) / 86_400_000;
      expect(jours).toBeCloseTo(3, 5);
      expect((await api().post(`${EDL}/${edl.id}/soumettre`).set(p.h).send({})).status).toBe(409);
      expect((await api().post(`${EDL}/${edl.id}/corriger`).set(p.h).send({})).status).toBe(409);
    });

    test('§ 52.4 état ACCEPTÉ immuable : CHAQUE route d’écriture → 409, rien ne change ; correction = nouvelle version tracée', async () => {
      const { p, locataire, edl } = await brouillonSortie();
      const item = elements(edl)[0];
      const ph = (await photo(p, edl.id, item.id)).body.data.photo;
      await api().post(`${EDL}/${edl.id}/soumettre`).set(p.h).send({});
      expect((await api().post(`${LOC}/${edl.id}/accepter`).set(locataire.h).send({})).status).toBe(200);
      const [avant] = await sequelize.query('SELECT i.condition, i.comment, i.label FROM inspection_items i WHERE i.inspection_id = :id ORDER BY i.id', { replacements: { id: edl.id } });
      const room = edl.rooms[0].id;
      const ecritures = [
        ['patch', `${EDL}/${edl.id}`, { keys_count: 9 }],
        ['delete', `${EDL}/${edl.id}`],
        ['post', `${EDL}/${edl.id}/pieces`, { name: 'Garage' }],
        ['patch', `${EDL}/${edl.id}/pieces/${room}`, { name: 'Renommée' }],
        ['delete', `${EDL}/${edl.id}/pieces/${room}`],
        ['post', `${EDL}/${edl.id}/pieces/${room}/elements`, { element: 'murs' }],
        ['patch', `${EDL}/${edl.id}/elements/${item.id}`, { condition: 'degrade' }],
        ['delete', `${EDL}/${edl.id}/elements/${item.id}`],
        ['delete', `${EDL}/${edl.id}/photos/${ph.id}`],
        ['put', `${EDL}/${edl.id}/saisie`, { items: [{ item_id: item.id, condition: 'hors_service' }] }],
        ['post', `${EDL}/${edl.id}/soumettre`, {}],
      ];
      const ecarts = [];
      for (const [m, u, c] of ecritures) {
        const res = await api()[m](u).set(p.h).send(c ?? {});
        if (res.status !== 409) ecarts.push(`${m} ${u} → ${res.status}`);
      }
      const photoRefusee = await photo(p, edl.id, item.id);
      if (photoRefusee.status !== 409) ecarts.push(`photo → ${photoRefusee.status}`);
      expect(ecarts).toEqual([]);
      const [apres] = await sequelize.query('SELECT i.condition, i.comment, i.label FROM inspection_items i WHERE i.inspection_id = :id ORDER BY i.id', { replacements: { id: edl.id } });
      expect(apres).toEqual(avant);
      expect(await compter('inspection_photos', 'inspection_id = :id', { id: edl.id })).toBe(1);
      expect(await compter('inspection_rooms', 'inspection_id = :id', { id: edl.id })).toBe(edl.rooms.length);

      const v2 = await api().post(`${EDL}/${edl.id}/corriger`).set(p.h).send({});
      expect(v2.status).toBe(201);
      expect(v2.body.data.inspection).toMatchObject({ version: 2, status: 'brouillon', previous_version_id: edl.id });
      expect(await compter('audit_logs', "action = 'etat_des_lieux.nouvelle_version' AND entity_id = :id", { id: v2.body.data.inspection.id })).toBe(1);
      expect(await compter('audit_logs', "action = 'etat_des_lieux.changement_statut' AND entity_id = :id AND details->>'apres' = 'remplace'", { id: edl.id })).toBe(1);
      // AUDIT #15 (versions) : la copie des photos dans le nouveau brouillon est cachée au locataire…
      const photoV2 = elements(v2.body.data.inspection).flatMap((i) => i.photos)[0];
      expect(photoV2.document.visible_to_tenant).toBe(false);
      expect((await api().get(`/api/v1/documents/${photoV2.document.id}/fichier`).set(locataire.h)).status).toBe(403);
      // … l'ancienne version (remplacée) reste consultable, avec son PDF archivé.
      const ancienne = await api().get(`${LOC}/${edl.id}`).set(locataire.h);
      expect(ancienne.body.data.inspection.status).toBe('remplace');
      expect((await api().get(`${LOC}/${edl.id}/pdf`).set(locataire.h)).status).toBe(200);
      // … puis visible à la soumission de la nouvelle version.
      await api().post(`${EDL}/${v2.body.data.inspection.id}/soumettre`).set(p.h).send({});
      expect((await api().get(`/api/v1/documents/${photoV2.document.id}/fichier`).set(locataire.h)).status).toBe(200);
    });

    test('espace locataire : liste filtrée (statut, type, bail), pagination, jamais de brouillon ; validation 422', async () => {
      const { p, locataire, lease, edl } = await brouillonSortie();
      expect((await api().get(LOC).set(locataire.h)).body.data.items).toEqual([]);
      await api().post(`${EDL}/${edl.id}/soumettre`).set(p.h).send({});
      const liste = await api().get(`${LOC}?status=soumis&type=sortie&lease_id=${lease.id}`).set(locataire.h);
      expect(liste.body.data.items.map((i) => i.id)).toEqual([edl.id]);
      expect(liste.body.data.items[0]).not.toHaveProperty('created_by');
      expect((await api().get(`${LOC}?status=accepte`).set(locataire.h)).body.data.items).toEqual([]);
      expect((await api().get(`${LOC}?limit=1&page=2`).set(locataire.h)).body.data.items).toEqual([]);
      const ecarts = await verifierStatuts([
        ['get', `${LOC}?status=brouillon`, undefined, 422],
        ['get', `${LOC}?page=0`, undefined, 422],
        ['get', `${LOC}?limit=0`, undefined, 422],
        ['get', `${LOC}?tri=version`, undefined, 422],
        ['get', `${LOC}/${UUID_INCONNU}`, undefined, 404],
        ['get', `${LOC}/abc`, undefined, 422],
        ['post', `${LOC}/${edl.id}/contester`, { comment: 'court' }, 422],
        ['post', `${LOC}/${edl.id}/contester`, {}, 422],
        ['post', `${LOC}/${edl.id}/contester`, { comment: 'x'.repeat(2001) }, 422],
      ], locataire.h);
      expect(ecarts).toEqual([]);
    });

    test('acceptation tacite : n’affecte pas un EDL contesté ; délai dépassé → accepter 409 DELAI_DEPASSE', async () => {
      const a = await brouillonSortie();
      const b = await brouillonSortie();
      for (const x of [a, b]) await api().post(`${EDL}/${x.edl.id}/soumettre`).set(x.p.h).send({});
      expect((await api().post(`${LOC}/${b.edl.id}/contester`).set(b.locataire.h).send({ comment: 'Plusieurs erreurs dans le relevé.' })).status).toBe(200);
      await sequelize.query("UPDATE inspections SET response_deadline = now() - interval '1 minute' WHERE id IN (:ids)", { replacements: { ids: [a.edl.id, b.edl.id] } });
      const tard = await api().post(`${LOC}/${a.edl.id}/accepter`).set(a.locataire.h).send({});
      expect(tard.status).toBe(409);
      expect(tard.body.error.code).toBe('DELAI_DEPASSE');
      await accepterTacitement();
      const [lignes] = await sequelize.query('SELECT id, status, accepted_tacitly FROM inspections WHERE id IN (:ids)', { replacements: { ids: [a.edl.id, b.edl.id] } });
      const parId = Object.fromEntries(lignes.map((l) => [l.id, [l.status, l.accepted_tacitly]]));
      expect(parId[a.edl.id]).toEqual(['accepte', true]);
      expect(parId[b.edl.id][0]).toBe('conteste');
      expect(await compter('notifications', "user_id = :u AND title = 'État des lieux accepté tacitement'", { u: a.locataire.user.id })).toBe(1);
    });

    test('comparaison : sortie manquante 409, bail inconnu 404, bail d’autrui 403 ; écarts avec photos', async () => {
      const { p, lease, edl } = await brouillonSortie();
      const sansEntree = await api().get(`${EDL}/comparaison?lease_id=${lease.id}`).set(p.h);
      expect(sansEntree.status).toBe(409);
      expect(sansEntree.body.error.code).toBe('ETAT_DES_LIEUX_MANQUANT');
      expect((await api().get(`${EDL}/comparaison?lease_id=${UUID_INCONNU}`).set(p.h)).status).toBe(404);
      expect((await api().get(`${EDL}/comparaison?lease_id=zz`).set(p.h)).status).toBe(422);
      expect((await api().get(`${EDL}/comparaison?lease_id=${lease.id}`).set((await nouveauProprietaire()).h)).status).toBe(403);

      const entree = (await api().post(EDL).set(p.h).send({ lease_id: lease.id, type: 'entree' })).body.data.inspection;
      const salonSortie = edl.rooms[0].items.find((i) => i.element === 'sols');
      await api().patch(`${EDL}/${edl.id}/elements/${salonSortie.id}`).set(p.h).send({ condition: 'degrade', comment: 'Carreau cassé' });
      await photo(p, edl.id, salonSortie.id);
      const res = await api().get(`${EDL}/comparaison?lease_id=${lease.id}`).set(p.h);
      expect(res.status).toBe(200);
      const c = res.body.data.comparaison;
      expect(c.entree.id).toBe(entree.id);
      expect(c.ecarts).toHaveLength(1);
      expect(c.ecarts[0]).toMatchObject({ element: 'sols', aggravation: 2, sortie: { condition: 'degrade', comment: 'Carreau cassé' } });
      expect(c.ecarts[0].sortie.photos).toHaveLength(1);
      expect(c.ecarts[0].sortie.photos[0].document).not.toHaveProperty('storage_key');
      expect(c.resume).toMatchObject({ ecarts: 1, absents: 0, nouveaux: 0 });
    });
  });

  describe('concurrence', () => {
    test('acceptation et contestation simultanées : une seule l’emporte, état cohérent', async () => {
      for (let i = 0; i < 3; i += 1) {
        const { p, locataire, edl } = await brouillonSortie();
        await api().post(`${EDL}/${edl.id}/soumettre`).set(p.h).send({});
        const [acc, con] = await Promise.all([
          api().post(`${LOC}/${edl.id}/accepter`).set(locataire.h).send({}),
          api().post(`${LOC}/${edl.id}/contester`).set(locataire.h).send({ comment: 'Je conteste le relevé des compteurs.' }),
        ]);
        expect([acc.status, con.status].sort()).toEqual([200, 409]);
        const [[ligne]] = await sequelize.query('SELECT status, document_id, locked_at FROM inspections WHERE id = :id', { replacements: { id: edl.id } });
        if (acc.status === 200) {
          expect(ligne.status).toBe('accepte');
          expect(ligne.document_id).not.toBeNull();
        } else {
          expect(ligne).toMatchObject({ status: 'conteste', document_id: null, locked_at: null });
          expect(await compter('documents', "entity_type = 'inspection' AND entity_id = :id AND category = 'etat_des_lieux'", { id: edl.id })).toBe(0);
        }
      }
    });

    test('deux « corriger » simultanés : une seule nouvelle version', async () => {
      const { p, locataire, lease, edl } = await brouillonSortie();
      await api().post(`${EDL}/${edl.id}/soumettre`).set(p.h).send({});
      await api().post(`${LOC}/${edl.id}/contester`).set(locataire.h).send({ comment: 'Le relevé est incomplet.' });
      const reponses = await Promise.all([1, 2].map(() => api().post(`${EDL}/${edl.id}/corriger`).set(p.h).send({})));
      expect(reponses.map((r) => r.status).sort()).toEqual([201, 409]);
      const [versions] = await sequelize.query("SELECT version, status FROM inspections WHERE lease_id = :l AND type = 'sortie' ORDER BY version", { replacements: { l: lease.id } });
      expect(versions).toEqual([{ version: 1, status: 'remplace' }, { version: 2, status: 'brouillon' }]);
    });
  });

  describe('sécurité', () => {
    let x;
    const routesProprio = (id, room, item, photoId) => [
      ['get', EDL], ['post', EDL], ['get', `${EDL}/comparaison?lease_id=${UUID_INCONNU}`], ['get', `${EDL}/${id}`], ['patch', `${EDL}/${id}`],
      ['delete', `${EDL}/${id}`], ['get', `${EDL}/${id}/pdf`], ['post', `${EDL}/${id}/pieces`], ['patch', `${EDL}/${id}/pieces/${room}`],
      ['delete', `${EDL}/${id}/pieces/${room}`], ['post', `${EDL}/${id}/pieces/${room}/elements`], ['patch', `${EDL}/${id}/elements/${item}`],
      ['delete', `${EDL}/${id}/elements/${item}`], ['post', `${EDL}/${id}/elements/${item}/photos`], ['delete', `${EDL}/${id}/photos/${photoId}`],
      ['put', `${EDL}/${id}/saisie`], ['post', `${EDL}/${id}/soumettre`], ['post', `${EDL}/${id}/corriger`],
    ];
    const routesLoc = (id) => [['get', LOC], ['get', `${LOC}/${id}`], ['get', `${LOC}/${id}/pdf`], ['post', `${LOC}/${id}/accepter`], ['post', `${LOC}/${id}/contester`]];

    beforeAll(async () => {
      x = await brouillonSortie();
      x.photo = (await photo(x.p, x.edl.id, elements(x.edl)[0].id)).body.data.photo;
    });

    test('authentification refusée sur les 23 routes (401 ; 403 compte désactivé)', async () => {
      const r = routesProprio(x.edl.id, x.edl.rooms[0].id, elements(x.edl)[0].id, x.photo.id);
      expect(await verifierMatrice(r, await jetonsDegrades('proprietaire'))).toEqual([]);
      expect(await verifierMatrice(routesLoc(x.edl.id), await jetonsDegrades('locataire'))).toEqual([]);
    });

    test('autre propriétaire → 403 sur chaque route ciblée, EDL inchangé ; locataire, admin, sans permission → 403', async () => {
      const autre = await nouveauProprietaire();
      const admin = await superAdmin();
      const sansDroit = await proprietaireSansPermission();
      const item = elements(x.edl)[0].id;
      const room = x.edl.rooms[0].id;
      const corps = {
        [`${EDL}/${x.edl.id}`]: { keys_count: 1 },
        [`${EDL}/${x.edl.id}/pieces`]: { name: 'Vol' },
        [`${EDL}/${x.edl.id}/pieces/${room}`]: { name: 'Vol' },
        [`${EDL}/${x.edl.id}/pieces/${room}/elements`]: { element: 'murs' },
        [`${EDL}/${x.edl.id}/elements/${item}`]: { condition: 'degrade' },
        [`${EDL}/${x.edl.id}/saisie`]: { items: [{ item_id: item, condition: 'degrade' }] },
      };
      const cibles = routesProprio(x.edl.id, room, item, x.photo.id).filter(([m, u]) => u.includes(x.edl.id) && !u.endsWith('/photos'));
      for (const [qui, h] of [['autre', autre.h], ['locataire', x.locataire.h], ['admin', admin.h], ['sans permission', sansDroit.h]]) {
        const ecarts = await verifierStatuts(cibles.map(([m, u]) => [m, u, corps[u] ?? {}, 403]), h);
        expect(`${qui}: ${ecarts.join(' | ')}`).toBe(`${qui}: `);
        expect((await photo({ h }, x.edl.id, item)).status).toBe(403);
      }
      expect(await verifierStatuts([['get', EDL, undefined, 403], ['get', `${EDL}/comparaison?lease_id=${x.lease.id}`, undefined, 403]], sansDroit.h)).toEqual([]);
      const detail = await api().get(`${EDL}/${x.edl.id}`).set(x.p.h);
      expect(detail.body.data.inspection.status).toBe('brouillon');
      expect(detail.body.data.inspection.keys_count).toBeNull();
      expect(elements(detail.body.data.inspection).map((i) => i.condition)).toEqual(elements(x.edl).map((i) => i.condition));
      expect(await compter('inspection_photos', 'inspection_id = :id', { id: x.edl.id })).toBe(1);
    });

    test('un autre locataire ne voit, n’accepte ni ne conteste l’état des lieux ; le propriétaire n’entre pas dans l’espace locataire', async () => {
      const cible = await brouillonSortie();
      await api().post(`${EDL}/${cible.edl.id}/soumettre`).set(cible.p.h).send({});
      const intrus = await proprietaireEtLocataire();
      const voisin = await activerLocataire(cible.p, (await bailActif(cible.p)).tenant);
      for (const h of [intrus.locataire.h, voisin.h]) {
        const ecarts = await verifierStatuts([
          ['get', `${LOC}/${cible.edl.id}`, undefined, 403],
          ['get', `${LOC}/${cible.edl.id}/pdf`, undefined, 403],
          ['post', `${LOC}/${cible.edl.id}/accepter`, {}, 403],
          ['post', `${LOC}/${cible.edl.id}/contester`, { comment: 'Je ne suis pas le locataire concerné.' }, 403],
        ], h);
        expect(ecarts).toEqual([]);
        expect((await api().get(LOC).set(h)).body.data.items.map((i) => i.id)).not.toContain(cible.edl.id);
      }
      expect((await api().get(LOC).set(cible.p.h)).status).toBe(403);
      expect((await api().post(`${LOC}/${cible.edl.id}/accepter`).set(cible.p.h).send({})).status).toBe(403);
      const [[ligne]] = await sequelize.query('SELECT status FROM inspections WHERE id = :id', { replacements: { id: cible.edl.id } });
      expect(ligne.status).toBe('soumis');
    });
  });
});
