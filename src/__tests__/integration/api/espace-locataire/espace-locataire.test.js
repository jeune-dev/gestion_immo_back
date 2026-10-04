'use strict';

const {
  api, nouveauProprietaire, superAdmin, proprietaireEtLocataire, bailActif, creerLocataire, echeancesDu, payerEspeces,
  MOT_DE_PASSE, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 28 Espace locataire (accueil, logement, échéances, consentement WhatsApp)
 * — « le locataire ne voit jamais les informations des autres locataires ».
 */

const BASE = '/api/v1/locataire';
const INCONNU = '00000000-0000-4000-8000-000000000000';

afterAll(fermer);

describe('Accueil et logement', () => {
  test('accueil : bail actif, prochaine échéance, reste dû ; aucune donnée d’un autre locataire', async () => {
    const { locataire, lease, apartment, building, proprio } = await proprietaireEtLocataire();
    const voisin = await bailActif(proprio);
    const res = await api().get(`${BASE}/accueil`).set(locataire.h);
    expect(res.status).toBe(200);
    expect(res.body.data.homes).toHaveLength(1);
    const home = res.body.data.homes[0];
    expect(home.lease).toMatchObject({ id: lease.id, status: 'actif', apartment: { id: apartment.id, building: { id: building.id } }, owner: { id: proprio.ownerId } });
    expect(home).toMatchObject({ amount_due: expect.anything(), amount_overdue: expect.anything() });
    expect(home.next_schedule).toMatchObject({ lease_id: lease.id });
    const texte = JSON.stringify(res.body);
    expect(texte).not.toContain(voisin.lease.id);
    expect(texte).not.toContain(voisin.tenant.phone);
    expect(texte).not.toMatch(/owner_id|settings|password_hash/);
  });

  test('logement : baux actifs d’abord puis historique ; bailleur limité au nom et au téléphone', async () => {
    const { locataire, lease, proprio } = await proprietaireEtLocataire();
    const res = await api().get(`${BASE}/logement`).set(locataire.h);
    expect(res.status).toBe(200);
    expect(res.body.data.leases.map((l) => l.id)).toEqual([lease.id]);
    expect(Object.keys(res.body.data.leases[0].owner).sort()).toEqual(['company_name', 'display_name', 'id', 'phone']);
    expect(res.body.data.leases[0].owner.id).toBe(proprio.ownerId);
  });

  test('bail terminé : absent de l’accueil, présent dans l’historique du logement', async () => {
    const { locataire, lease } = await proprietaireEtLocataire();
    await sequelize.query("UPDATE leases SET status = 'termine' WHERE id = :l", { replacements: { l: lease.id } });
    expect((await api().get(`${BASE}/accueil`).set(locataire.h)).body.data.homes).toEqual([]);
    expect((await api().get(`${BASE}/logement`).set(locataire.h)).body.data.leases.map((l) => l.status)).toEqual(['termine']);
  });

  test('deux bailleurs : le même compte voit ses deux logements', async () => {
    const { locataire, tenant, lease } = await proprietaireEtLocataire();
    const proprioB = await nouveauProprietaire();
    const bailB = await bailActif(proprioB);
    await sequelize.query('UPDATE tenants SET user_id = :u, phone = :p WHERE id = :t', { replacements: { u: locataire.user.id, p: tenant.phone, t: bailB.tenant.id } });
    const res = await api().get(`${BASE}/logement`).set(locataire.h);
    expect(res.body.data.leases.map((l) => l.id).sort()).toEqual([lease.id, bailB.lease.id].sort());
  });
});

describe('Échéances', () => {
  test('liste : ses échéances seulement, filtres, ordre, pagination exacte', async () => {
    const { locataire, lease, proprio } = await proprietaireEtLocataire();
    const voisin = await bailActif(proprio);
    const toutes = await api().get(`${BASE}/echeances`).query({ limit: 100 }).set(locataire.h);
    expect(toutes.status).toBe(200);
    const items = toutes.body.data.items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((e) => e.lease_id === lease.id)).toBe(true);
    expect(items[0]).not.toHaveProperty('owner_id');
    expect(toutes.body.data.pagination.total).toBe(await compter('rent_schedules', "lease_id = :l AND status <> 'annule'", { l: lease.id }));

    const asc = await api().get(`${BASE}/echeances`).query({ ordre: 'asc', limit: 100 }).set(locataire.h);
    const dates = asc.body.data.items.map((e) => e.due_date);
    expect(dates).toEqual([...dates].sort());

    const autreBail = await api().get(`${BASE}/echeances`).query({ lease_id: voisin.lease.id }).set(locataire.h);
    expect(autreBail.status).toBe(200);
    expect(autreBail.body.data.items).toEqual([]);

    const page2 = await api().get(`${BASE}/echeances`).query({ limit: 1, page: 2 }).set(locataire.h);
    expect(page2.body.data.pagination).toMatchObject({ page: 2, limit: 1, total: items.length });
    const periode = await api().get(`${BASE}/echeances`).query({ du: '2099-01-01' }).set(locataire.h);
    expect(periode.body.data.items).toEqual([]);
  });

  test('filtre « à payer » et statut', async () => {
    const { locataire, proprio, lease } = await proprietaireEtLocataire();
    const [premiere] = await echeancesDu(proprio, lease.id);
    await payerEspeces(proprio, lease.id, Number(premiere.amount_due), { scheduleId: premiere.id });
    const payees = await api().get(`${BASE}/echeances`).query({ status: 'paye' }).set(locataire.h);
    expect(payees.body.data.items.map((e) => e.id)).toContain(premiere.id);
    const aPayer = await api().get(`${BASE}/echeances`).query({ a_payer: true, limit: 100 }).set(locataire.h);
    expect(aPayer.body.data.items.every((e) => ['a_payer', 'partiellement_paye', 'en_retard'].includes(e.status))).toBe(true);
  });

  test('détail : la sienne 200 (allocations), celle d’un autre locataire 403, inconnue 404, identifiant invalide 422', async () => {
    const { locataire, proprio, lease } = await proprietaireEtLocataire();
    const [e] = await echeancesDu(proprio, lease.id);
    await payerEspeces(proprio, lease.id, 1000, { scheduleId: e.id });
    const res = await api().get(`${BASE}/echeances/${e.id}`).set(locataire.h);
    expect(res.status).toBe(200);
    expect(res.body.data.schedule).toMatchObject({ id: e.id, allocations: [expect.objectContaining({ amount: 1000 })] });
    expect(res.body.data.schedule).not.toHaveProperty('owner_id');

    const autre = await proprietaireEtLocataire();
    const [eAutre] = await echeancesDu(autre.proprio, autre.lease.id);
    const refus = await api().get(`${BASE}/echeances/${eAutre.id}`).set(locataire.h);
    expect(refus.status).toBe(403);
    expect(refus.body.error.code).toBe('ACCES_AUTRE_LOCATAIRE');
    expect((await api().get(`${BASE}/echeances/${INCONNU}`).set(locataire.h)).status).toBe(404);
    expect((await api().get(`${BASE}/echeances/abc`).set(locataire.h)).status).toBe(422);
  });

  test.each([
    ['statut inconnu', { status: 'offert' }], ['bail non UUID', { lease_id: '1' }], ['date invalide', { du: '2026-02-31x' }],
    ['ordre inconnu', { ordre: 'aleatoire' }], ['page 0', { page: 0 }], ['limit 0', { limit: 0 }], ['a_payer non booléen', { a_payer: 'peut-etre' }],
  ])('paramètre invalide 422 : %s', async (_l, query) => {
    const { locataire } = await proprietaireEtLocataire();
    expect((await api().get(`${BASE}/echeances`).query(query).set(locataire.h)).status).toBe(422);
  });
});

describe('Consentement WhatsApp (locataire)', () => {
  test('retrait puis accord pour toutes ses fiches ; audit « par locataire »', async () => {
    const { locataire, tenant, proprio } = await proprietaireEtLocataire();
    const retrait = await api().post(`${BASE}/consentement-whatsapp`).set(locataire.h).send({ accorde: false });
    expect(retrait.status).toBe(200);
    expect(retrait.body.data.consents).toEqual([{ tenant_id: tenant.id, whatsapp_consent: false }]);
    const [[ligne]] = await sequelize.query('SELECT whatsapp_consent, whatsapp_consent_revoked_at FROM tenants WHERE id = :t', { replacements: { t: tenant.id } });
    expect(ligne.whatsapp_consent).toBe(false);
    expect(ligne.whatsapp_consent_revoked_at).not.toBeNull();
    const accord = await api().post(`${BASE}/consentement-whatsapp`).set(locataire.h).send({ accorde: true, tenant_id: tenant.id });
    expect(accord.body.data.consents).toEqual([{ tenant_id: tenant.id, whatsapp_consent: true }]);
    expect(await compter('audit_logs', "action = 'locataire.consentement_whatsapp' AND entity_id = :t AND owner_id = :o AND details->>'par' = 'locataire'", { t: tenant.id, o: proprio.ownerId })).toBe(2);
  });

  test('fiche d’un AUTRE locataire : 403, consentement de l’autre inchangé', async () => {
    const { locataire } = await proprietaireEtLocataire();
    const autre = await nouveauProprietaire();
    const victime = await creerLocataire(autre, { whatsapp_consent: true });
    const res = await api().post(`${BASE}/consentement-whatsapp`).set(locataire.h).send({ accorde: false, tenant_id: victime.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCES_AUTRE_LOCATAIRE');
    expect(await compter('tenants', 'id = :t AND whatsapp_consent = true AND whatsapp_consent_revoked_at IS NULL', { t: victime.id })).toBe(1);
  });

  test('validation : accorde manquant ou non booléen, tenant_id non UUID → 422', async () => {
    const { locataire } = await proprietaireEtLocataire();
    for (const corps of [{}, { accorde: 'oui-oui' }, { accorde: true, tenant_id: 'x' }]) {
      expect((await api().post(`${BASE}/consentement-whatsapp`).set(locataire.h).send(corps)).status).toBe(422);
    }
  });
});

describe('Contrôle d’accès de l’espace locataire', () => {
  test('propriétaire et super admin : 403 ESPACE_LOCATAIRE_REQUIS ; anonyme 401', async () => {
    const p = await nouveauProprietaire();
    const admin = await superAdmin();
    for (const h of [p.h, admin.h]) {
      for (const chemin of ['/accueil', '/logement', '/echeances', '/caution']) {
        const res = await api().get(`${BASE}${chemin}`).set(h);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ESPACE_LOCATAIRE_REQUIS');
      }
      expect((await api().post(`${BASE}/consentement-whatsapp`).set(h).send({ accorde: true })).status).toBe(403);
    }
    expect((await api().get(`${BASE}/accueil`)).status).toBe(401);
  });

  test('locataire → routes propriétaire et admin : 403', async () => {
    const { locataire, tenant } = await proprietaireEtLocataire();
    for (const chemin of ['/api/v1/immeubles', '/api/v1/appartements', '/api/v1/locataires', `/api/v1/locataires/${tenant.id}`, '/api/v1/parametres', '/api/v1/admin/dashboard']) {
      expect((await api().get(chemin).set(locataire.h)).status).toBe(403);
    }
    expect((await api().post(`/api/v1/locataires/${tenant.id}/consentement-whatsapp`).set(locataire.h).send({ accorde: true })).status).toBe(403);
  });

  test('caution : lisible par le locataire', async () => {
    const { locataire } = await proprietaireEtLocataire();
    expect((await api().get(`${BASE}/caution`).set(locataire.h)).status).toBe(200);
  });

  test('compte sans aucune fiche rattachée : 403 AUCUN_LOGEMENT', async () => {
    const { locataire, tenant } = await proprietaireEtLocataire();
    await sequelize.query('UPDATE tenants SET user_id = NULL WHERE id = :t', { replacements: { t: tenant.id } });
    const res = await api().get(`${BASE}/accueil`).set(locataire.h);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUCUN_LOGEMENT');
  });

  test('compte locataire désactivé : 403 COMPTE_INACTIF ; connexion refusée', async () => {
    const { locataire, tenant } = await proprietaireEtLocataire();
    await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :u", { replacements: { u: locataire.user.id } });
    expect((await api().get(`${BASE}/logement`).set(locataire.h)).body.error.code).toBe('COMPTE_INACTIF');
    expect((await api().post('/api/v1/auth/connexion').send({ identifiant: tenant.phone, password: MOT_DE_PASSE })).status).toBe(403);
  });
});
