'use strict';

const fs = require('fs');
const path = require('path');
const {
  api, nouveauProprietaire, superAdmin, bailActif, activerLocataire, proprietaireEtLocataire, pngTest,
  expirerAbonnement, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const storage = require('../../../../infrastructure/storage.service.js');
const droits = require('../../../../modules/abonnement/service/droits.service.js');
const {
  UUID_INCONNU, jetonsDegrades, verifierMatrice, verifierStatuts, proprietaireSansPermission,
} = require('../baux/securite.outils.js');

/**
 * Messagerie (§ 54.1) — toutes les routes, propriétaire et locataire : fil
 * unique par couple, état envoyé / lu (accusés de lecture), rattachement à
 * une ressource DU dossier du locataire, photos (signature binaire, pas
 * d'orphelin), formule sans messagerie, isolation stricte (§ 56.2 « visible
 * uniquement des deux parties »), pagination et concurrence.
 */

const BASE = '/api/v1/messagerie';
const LOC = '/api/v1/locataire/messagerie';

const ecrire = (p, tenantId, body, extra = {}) => api().post(`${BASE}/locataires/${tenantId}/messages`).set(p.h).send({ body, ...extra });
const repondre = (loc, filId, body, extra = {}) => api().post(`${LOC}/${filId}/messages`).set(loc.h).send({ body, ...extra });

async function incident(p, buildingId, tenantId) {
  const [[ligne]] = await sequelize.query(
    `INSERT INTO incidents (owner_id, tenant_id, building_id, reference, category, title, description, reported_by)
     VALUES (:o, :t, :b, :r, 'fuite', 'Fuite', 'Fuite sous l''évier', :u) RETURNING id`,
    { replacements: { o: p.ownerId, t: tenantId, b: buildingId, u: p.user.id, r: `INC-${Math.random().toString(36).slice(2, 10)}` } }
  );
  return ligne.id;
}

const fichiersDe = (ownerId) => {
  const dossier = path.join(storage.UPLOAD_DIR, 'owners', ownerId, 'message');
  return fs.existsSync(dossier) ? fs.readdirSync(dossier, { recursive: true }).filter((f) => fs.statSync(path.join(dossier, f)).isFile()) : [];
};

describe('Messagerie — API complète (§ 54.1)', () => {
  afterAll(fermer);

  describe('fils et messages', () => {
    test('propriétaire : aucun fil avant le premier message ; le locataire voit d’emblée un fil vide par propriétaire', async () => {
      const { proprio: p, locataire } = await proprietaireEtLocataire();
      expect((await api().get(`${BASE}/fils`).set(p.h)).body.data).toEqual({ items: [], pagination: expect.objectContaining({ total: 0 }) });
      const fils = await api().get(LOC).set(locataire.h);
      expect(fils.status).toBe(200);
      expect(fils.body.data.items).toHaveLength(1);
      expect(fils.body.data.items[0]).toMatchObject({ unread_count: 0, last_message: null, owner: { id: p.ownerId } });
      // Consulter deux fois ne crée pas de second fil.
      await api().get(LOC).set(locataire.h);
      expect(await compter('message_threads', 'owner_id = :o', { o: p.ownerId })).toBe(1);
      // Le fil vide n'apparaît toujours pas côté propriétaire.
      expect((await api().get(`${BASE}/fils`).set(p.h)).body.data.items).toEqual([]);
    });

    test('accusés de lecture : seuls les messages REÇUS passent « lu » ; relecture idempotente ; notifications à chaque message', async () => {
      const { proprio: p, locataire, tenant } = await proprietaireEtLocataire();
      const m1 = await ecrire(p, tenant.id, 'Bonjour, visite technique jeudi.');
      expect(m1.status).toBe(201);
      expect(m1.body.data.message).toMatchObject({ status: 'envoye', read_at: null, sender_role: 'proprietaire', sender_user_id: p.user.id, document: null });
      const fil = m1.body.data.message.thread_id;
      const r1 = await repondre(locataire, fil, 'Très bien, merci.');
      expect(r1.status).toBe(201);

      // Le propriétaire lit : seul le message du locataire devient « lu ».
      const luProprio = await api().post(`${BASE}/fils/${fil}/lu`).set(p.h);
      expect(luProprio.body.data.marques).toBe(1);
      expect((await api().post(`${BASE}/fils/${fil}/lu`).set(p.h)).body.data.marques).toBe(0);
      const cote = await api().get(`${BASE}/fils/${fil}/messages`).set(p.h);
      const parId = Object.fromEntries(cote.body.data.items.map((m) => [m.id, m.status]));
      expect(parId).toEqual({ [m1.body.data.message.id]: 'envoye', [r1.body.data.message.id]: 'lu' });
      const [[lu]] = await sequelize.query('SELECT read_at FROM messages WHERE id = :id', { replacements: { id: r1.body.data.message.id } });
      expect(lu.read_at).not.toBeNull();

      const luLoc = await api().post(`${LOC}/${fil}/lu`).set(locataire.h);
      expect(luLoc.body.data.marques).toBe(1);
      expect((await api().get(`${LOC}/${fil}/messages`).set(locataire.h)).body.data.items.every((m) => m.status === 'lu')).toBe(true);

      expect(await compter('notifications', "user_id = :u AND type = 'nouveau_message'", { u: locataire.user.id })).toBe(1);
      expect(await compter('notifications', "user_id = :u AND type = 'nouveau_message'", { u: p.user.id })).toBe(1);
      // Jamais de WhatsApp pour une conversation (§ 54.3).
      expect(await compter('message_deliveries', "channel = 'whatsapp' AND owner_id = :o", { o: p.ownerId })).toBe(0);
    });

    test('pagination des messages (récents d’abord) et des fils ; paramètres invalides 422', async () => {
      const { proprio: p, locataire, tenant } = await proprietaireEtLocataire();
      const ids = [];
      for (let i = 1; i <= 5; i += 1) ids.push((await ecrire(p, tenant.id, `Message ${i}`)).body.data.message.id);
      const fil = (await api().get(`${BASE}/fils`).set(p.h)).body.data.items[0].id;
      const p1 = await api().get(`${BASE}/fils/${fil}/messages?limit=2`).set(p.h);
      expect(p1.body.data.items.map((m) => m.body)).toEqual(['Message 5', 'Message 4']);
      expect(p1.body.data.pagination).toMatchObject({ total: 5, totalPages: 3 });
      expect((await api().get(`${LOC}/${fil}/messages?limit=2&page=3`).set(locataire.h)).body.data.items.map((m) => m.body)).toEqual(['Message 1']);
      expect((await api().get(`${LOC}/${fil}/messages?limit=2&page=4`).set(locataire.h)).body.data.items).toEqual([]);
      expect((await api().get(`${BASE}/fils/${fil}/messages?limit=1000`).set(p.h)).body.data.pagination.limit).toBe(100);
      const fils = await api().get(`${BASE}/fils`).set(p.h);
      expect(fils.body.data.items[0]).toMatchObject({ unread_count: 0, last_message: { preview: 'Message 5', status: 'envoye', has_photo: false } });
      expect((await api().get(LOC).set(locataire.h)).body.data.items[0].unread_count).toBe(5);
      const ecartsP = await verifierStatuts([
        ['get', `${BASE}/fils?page=0`, undefined, 422],
        ['get', `${BASE}/fils?limit=0`, undefined, 422],
        ['get', `${BASE}/fils/${fil}/messages?page=-1`, undefined, 422],
      ], p.h);
      const ecartsL = await verifierStatuts([
        ['get', `${LOC}?page=0`, undefined, 422],
        ['get', `${LOC}/${fil}/messages?limit=0`, undefined, 422],
      ], locataire.h);
      expect([...ecartsP, ...ecartsL]).toEqual([]);
    });

    test('validation : corps vide, trop long, non textuel ; rattachement incomplet ou inconnu ; identifiants invalides', async () => {
      const { proprio: p, locataire, tenant } = await proprietaireEtLocataire();
      const fil = (await ecrire(p, tenant.id, 'Bonjour')).body.data.message.thread_id;
      const u = `${BASE}/locataires/${tenant.id}/messages`;
      const ecarts = await verifierStatuts([
        ['post', u, {}, 422],
        ['post', u, { body: '' }, 422],
        ['post', u, { body: '    ' }, 422],
        ['post', u, { body: 'x'.repeat(4001) }, 422],
        ['post', u, { body: 12345 }, 422],
        ['post', u, { body: 'x', related_type: 'incident' }, 422],
        ['post', u, { body: 'x', related_id: UUID_INCONNU }, 422],
        ['post', u, { body: 'x', related_type: 'bail', related_id: UUID_INCONNU }, 422],
        ['post', u, { body: 'x', related_type: 'incident', related_id: UUID_INCONNU }, 422],
        ['post', `${BASE}/locataires/abc/messages`, { body: 'x' }, 422],
        ['post', `${BASE}/locataires/${UUID_INCONNU}/messages`, { body: 'x' }, 404],
        ['get', `${BASE}/fils/abc/messages`, undefined, 422],
        ['post', `${BASE}/fils/${UUID_INCONNU}/lu`, undefined, 404],
      ], p.h);
      expect(ecarts).toEqual([]);
      expect(await verifierStatuts([
        ['post', `${LOC}/${fil}/messages`, { body: '' }, 422],
        ['post', `${LOC}/abc/messages`, { body: 'x' }, 422],
        ['post', `${LOC}/${UUID_INCONNU}/messages`, { body: 'x' }, 404],
        ['post', `${LOC}/${UUID_INCONNU}/lu`, undefined, 404],
      ], locataire.h)).toEqual([]);
      expect(await compter('messages', 'thread_id = :f', { f: fil })).toBe(1);
    });

    test('rattachement côté propriétaire : la ressource doit concerner CE locataire (incident, échéance) → sinon 403 RATTACHEMENT_REFUSE', async () => {
      const { proprio: p, locataire, tenant, building } = await proprietaireEtLocataire();
      const voisin = await bailActif(p);
      const incidentVoisin = await incident(p, voisin.building.id, voisin.tenant.id);
      const [[echeanceVoisin]] = await sequelize.query('SELECT id FROM rent_schedules WHERE tenant_id = :t LIMIT 1', { replacements: { t: voisin.tenant.id } });
      const [[echeanceMienne]] = await sequelize.query('SELECT id FROM rent_schedules WHERE tenant_id = :t LIMIT 1', { replacements: { t: tenant.id } });
      for (const [type, id] of [['incident', incidentVoisin], ['rent_schedule', echeanceVoisin.id]]) {
        const res = await ecrire(p, tenant.id, 'Voir ce dossier', { related_type: type, related_id: id });
        expect(`${type} → ${res.status} ${res.body.error?.code}`).toBe(`${type} → 403 RATTACHEMENT_REFUSE`);
      }
      expect(await compter('messages m JOIN message_threads t ON t.id = m.thread_id', 't.tenant_id = :t', { t: tenant.id })).toBe(0);
      const ok = await ecrire(p, tenant.id, 'Votre loyer', { related_type: 'rent_schedule', related_id: echeanceMienne.id });
      expect(ok.status).toBe(201);
      expect(ok.body.data.message).toMatchObject({ related_type: 'rent_schedule', related_id: echeanceMienne.id });
      const monIncident = await incident(p, building.id, tenant.id);
      expect((await ecrire(p, tenant.id, 'Plombier demain', { related_type: 'incident', related_id: monIncident })).status).toBe(201);
      // Le locataire voit ses messages rattachés.
      const vus = await api().get(`${LOC}/${ok.body.data.message.thread_id}/messages`).set(locataire.h);
      expect(vus.body.data.items.map((m) => m.related_type).sort()).toEqual(['incident', 'rent_schedule']);
    });

    test('photos : message photo avec ou sans légende ; fichier non image, texte, trop gros → 400 sans orphelin', async () => {
      const { proprio: p, locataire, tenant } = await proprietaireEtLocataire();
      const envoi = await api().post(`${BASE}/locataires/${tenant.id}/photos`).set(p.h).attach('fichier', await pngTest(), 'compteur.png');
      expect(envoi.status).toBe(201);
      expect(envoi.body.data.message).toMatchObject({ body: null, document: { category: 'photo', visible_to_tenant: true } });
      const fil = envoi.body.data.message.thread_id;
      const avant = fichiersDe(p.ownerId).length;
      const avantDocs = await compter('documents', "owner_id = :o AND entity_type = 'message'", { o: p.ownerId });
      const gros = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(10.5 * 1024 * 1024)]);
      const refus = [
        await api().post(`${BASE}/locataires/${tenant.id}/photos`).set(p.h).attach('fichier', Buffer.from('%PDF-1.4 pas une photo\n%%EOF'), 'doc.png'),
        await api().post(`${BASE}/locataires/${tenant.id}/photos`).set(p.h).attach('fichier', Buffer.from('texte brut déguisé en image'), 'x.jpg'),
        await api().post(`${LOC}/${fil}/photos`).set(locataire.h).attach('fichier', gros, 'enorme.png'),
        await api().post(`${LOC}/${fil}/photos`).set(locataire.h).field('body', 'sans fichier'),
      ];
      expect(refus.map((r) => r.status)).toEqual([400, 400, 400, 400]);
      const legende = await api().post(`${BASE}/locataires/${tenant.id}/photos`).set(p.h).field('body', 'x'.repeat(4001)).attach('fichier', await pngTest(), 'a.png');
      expect(legende.status).toBe(422);
      expect(fichiersDe(p.ownerId)).toHaveLength(avant);
      expect(await compter('documents', "owner_id = :o AND entity_type = 'message'", { o: p.ownerId })).toBe(avantDocs);
      const photoLoc = await api().post(`${LOC}/${fil}/photos`).set(locataire.h).field('body', 'La fuite').attach('fichier', await pngTest('#00f'), 'fuite.png');
      expect(photoLoc.status).toBe(201);
      expect(photoLoc.body.data.message).toMatchObject({ body: 'La fuite', sender_role: 'locataire' });
      expect((await api().get(`/api/v1/documents/${photoLoc.body.data.message.document.id}/fichier`).set(p.h)).status).toBe(200);
    });
  });

  describe('règles d’abonnement', () => {
    test('formule sans messagerie : envoi refusé des deux côtés (403), historique toujours lisible', async () => {
      const { proprio: p, locataire, tenant } = await proprietaireEtLocataire();
      const fil = (await ecrire(p, tenant.id, 'Avant le changement de formule')).body.data.message.thread_id;
      const code = `SANS_MSG_${p.ownerId.slice(0, 6)}`;
      await sequelize.query(
        "INSERT INTO subscription_plans (code, name, price, features) VALUES (:code, 'Sans messagerie', 0, ARRAY['rapports'])",
        { replacements: { code } }
      );
      await sequelize.query('UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = :code) WHERE owner_id = :o', { replacements: { code, o: p.ownerId } });
      await droits.invalider(p.ownerId);
      const proprio = await ecrire(p, tenant.id, 'Encore un message');
      expect(proprio.status).toBe(403);
      expect(proprio.body.error.code).toBe('FONCTIONNALITE_NON_INCLUSE');
      const loc = await repondre(locataire, fil, 'Réponse du locataire');
      expect(loc.status).toBe(403);
      expect(loc.body.error.code).toBe('MESSAGERIE_INDISPONIBLE');
      expect((await api().get(`${BASE}/fils/${fil}/messages`).set(p.h)).body.data.items).toHaveLength(1);
      expect((await api().get(`${LOC}/${fil}/messages`).set(locataire.h)).status).toBe(200);
      expect(await compter('messages', 'thread_id = :f', { f: fil })).toBe(1);
    });

    test('abonnement échu : le propriétaire lit (200) mais n’écrit plus (402) ; le locataire ne peut plus écrire (403)', async () => {
      const { proprio: p, locataire, tenant } = await proprietaireEtLocataire();
      const fil = (await ecrire(p, tenant.id, 'Bonjour')).body.data.message.thread_id;
      await expirerAbonnement(p.ownerId);
      expect((await api().get(`${BASE}/fils`).set(p.h)).status).toBe(200);
      expect((await ecrire(p, tenant.id, 'Refusé')).status).toBe(402);
      expect((await repondre(locataire, fil, 'Refusé aussi')).status).toBe(403);
    });
  });

  describe('isolation et sécurité', () => {
    test('§ 56.2 : un voisin (même propriétaire) ou un locataire d’ailleurs ne lit, n’écrit ni n’accuse lecture du fil', async () => {
      const { proprio: p, locataire, tenant } = await proprietaireEtLocataire();
      const fil = (await ecrire(p, tenant.id, 'Message confidentiel')).body.data.message.thread_id;
      const voisin = await activerLocataire(p, (await bailActif(p)).tenant);
      const ailleurs = await proprietaireEtLocataire();
      for (const h of [voisin.h, ailleurs.locataire.h]) {
        expect(await verifierStatuts([
          ['get', `${LOC}/${fil}/messages`, undefined, 403],
          ['post', `${LOC}/${fil}/messages`, { body: 'Intrusion' }, 403],
          ['post', `${LOC}/${fil}/lu`, undefined, 403],
        ], h)).toEqual([]);
        expect((await api().post(`${LOC}/${fil}/photos`).set(h).attach('fichier', await pngTest(), 'x.png')).status).toBe(403);
        expect((await api().get(LOC).set(h)).body.data.items.map((f) => f.id)).not.toContain(fil);
      }
      expect(await verifierStatuts([
        ['get', `${BASE}/fils/${fil}/messages`, undefined, 403],
        ['post', `${BASE}/fils/${fil}/lu`, undefined, 403],
        ['post', `${BASE}/locataires/${tenant.id}/messages`, { body: 'Intrusion' }, 403],
      ], ailleurs.proprio.h)).toEqual([]);
      expect((await api().post(`${BASE}/locataires/${tenant.id}/photos`).set(ailleurs.proprio.h).attach('fichier', await pngTest(), 'x.png')).status).toBe(403);
      const [[m]] = await sequelize.query('SELECT count(*)::int AS n, count(read_at)::int AS lus FROM messages WHERE thread_id = :f', { replacements: { f: fil } });
      expect(m).toEqual({ n: 1, lus: 0 });
      expect((await api().get(LOC).set(locataire.h)).body.data.items.map((f) => f.id)).toEqual([fil]);
    });

    test('concurrence : deux premiers messages simultanés → un seul fil', async () => {
      const { proprio: p, tenant } = await proprietaireEtLocataire();
      const reponses = await Promise.all([1, 2, 3].map((i) => ecrire(p, tenant.id, `Simultané ${i}`)));
      expect(reponses.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(new Set(reponses.map((r) => r.body.data.message.thread_id)).size).toBe(1);
      expect(await compter('message_threads', 'tenant_id = :t', { t: tenant.id })).toBe(1);
    });

    test('authentification refusée sur les 10 routes (401 ; 403 compte désactivé)', async () => {
      const { proprio: p, tenant } = await proprietaireEtLocataire();
      const fil = (await ecrire(p, tenant.id, 'Bonjour')).body.data.message.thread_id;
      const routesP = [['get', `${BASE}/fils`], ['get', `${BASE}/fils/${fil}/messages`], ['post', `${BASE}/fils/${fil}/lu`], ['post', `${BASE}/locataires/${tenant.id}/messages`], ['post', `${BASE}/locataires/${tenant.id}/photos`]];
      const routesL = [['get', LOC], ['get', `${LOC}/${fil}/messages`], ['post', `${LOC}/${fil}/messages`], ['post', `${LOC}/${fil}/photos`], ['post', `${LOC}/${fil}/lu`]];
      expect(await verifierMatrice(routesP, await jetonsDegrades('proprietaire'))).toEqual([]);
      expect(await verifierMatrice(routesL, await jetonsDegrades('locataire'))).toEqual([]);
    });

    test('rôles : locataire sur l’espace propriétaire, propriétaire sur l’espace locataire, super admin, sans permission → 403', async () => {
      const { proprio: p, locataire, tenant } = await proprietaireEtLocataire();
      const fil = (await ecrire(p, tenant.id, 'Bonjour')).body.data.message.thread_id;
      const admin = await superAdmin();
      const sansDroit = await proprietaireSansPermission();
      const routesP = [['get', `${BASE}/fils`], ['get', `${BASE}/fils/${fil}/messages`], ['post', `${BASE}/fils/${fil}/lu`], ['post', `${BASE}/locataires/${tenant.id}/messages`, { body: 'x' }]];
      const routesL = [['get', LOC], ['get', `${LOC}/${fil}/messages`], ['post', `${LOC}/${fil}/messages`, { body: 'x' }], ['post', `${LOC}/${fil}/lu`]];
      for (const h of [locataire.h, admin.h, sansDroit.h]) expect(await verifierStatuts(routesP.map(([m, u, c]) => [m, u, c, 403]), h)).toEqual([]);
      for (const h of [p.h, admin.h]) expect(await verifierStatuts(routesL.map(([m, u, c]) => [m, u, c, 403]), h)).toEqual([]);
      expect(await compter('messages', 'thread_id = :f', { f: fil })).toBe(1);
    });
  });
});
