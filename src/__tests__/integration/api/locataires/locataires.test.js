'use strict';

const {
  api, nouveauProprietaire, superAdmin, creerLocataire, bailActif, activerLocataire, proprietaireEtLocataire,
  telephoneUnique, emailUnique, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 9 Locataires (espace propriétaire) — fiche, pièce d'identité chiffrée
 * (§ 32), invitation (§ 5 option A), consentement WhatsApp (§ 54.3, § 56.1),
 * contrôle d'accès et listes.
 */

const URL = '/api/v1/locataires';
const INCONNU = '00000000-0000-4000-8000-000000000000';

afterAll(fermer);

const creer = (p, corps) => api().post(URL).set(p.h).send({ first_name: 'Fatou', last_name: 'Sarr', phone: telephoneUnique(), ...corps });

describe('Création', () => {
  test('nominal : fiche, pièce d’identité chiffrée au repos, audit, pas d’invitation par défaut', async () => {
    const p = await nouveauProprietaire();
    const res = await creer(p, { email: emailUnique('fatou'), id_document_type: 'cni', id_document_number: '1 234 5678 90123', notes: 'Payeur ponctuel' });
    expect(res.status).toBe(201);
    const t = res.body.data.tenant;
    expect(t).toMatchObject({ owner_id: p.ownerId, first_name: 'Fatou', id_document_type: 'cni', id_document_number: '1 234 5678 90123', whatsapp_consent: false, user_id: null, created_by: p.user.id });
    expect(res.body.data.invitation).toBeNull();
    const [[brut]] = await sequelize.query('SELECT id_document_number FROM tenants WHERE id = :id', { replacements: { id: t.id } });
    expect(brut.id_document_number).toMatch(/^v1:/);
    expect(brut.id_document_number).not.toContain('5678');
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'locataire.creation' AND entity_id = :id", { replacements: { id: t.id } });
    expect(audit.details).toEqual({ nom: 'Fatou Sarr', whatsapp_consent: false });
    expect(JSON.stringify(audit.details)).not.toContain('5678');
  });

  test('option A : invitation créée à la création (code 8 chiffres + lien), canal manuel sans e-mail', async () => {
    const p = await nouveauProprietaire();
    const res = await creer(p, { send_invitation: true });
    expect(res.status).toBe(201);
    expect(res.body.data.invitation).toMatchObject({ code: expect.stringMatching(/^\d{8}$/), token: expect.any(String), canal: 'manuel' });
    const [[inv]] = await sequelize.query('SELECT token_hash, code_hash FROM tenant_invitations WHERE tenant_id = :t', { replacements: { t: res.body.data.tenant.id } });
    expect(inv.token_hash).not.toBe(res.body.data.invitation.token);
    expect(inv.code_hash).not.toContain(res.body.data.invitation.code);
  });

  test('consentement WhatsApp déclaré à la création : horodaté', async () => {
    const p = await nouveauProprietaire();
    const res = await creer(p, { whatsapp_consent: true });
    expect(res.body.data.tenant).toMatchObject({ whatsapp_consent: true, whatsapp_consent_at: expect.any(String), whatsapp_consent_revoked_at: null });
  });

  test('élévation : owner_id, user_id, created_by, whatsapp_consent_revoked_at ignorés', async () => {
    const victime = await nouveauProprietaire();
    const p = await nouveauProprietaire();
    const res = await creer(p, { owner_id: victime.ownerId, user_id: victime.user.id, created_by: victime.user.id, whatsapp_consent_revoked_at: '2020-01-01' });
    expect(res.status).toBe(201);
    expect(res.body.data.tenant).toMatchObject({ owner_id: p.ownerId, user_id: null, created_by: p.user.id, whatsapp_consent_revoked_at: null });
  });

  test('téléphone déjà enregistré chez ce propriétaire (autre format) : 409 ; chez un autre propriétaire : permis', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p);
    const doublon = await creer(p, { phone: t.phone.replace('+221', '') });
    expect(doublon.status).toBe(409);
    expect(doublon.body.error.code).toBe('LOCATAIRE_EXISTANT');
    const autre = await nouveauProprietaire();
    expect((await creer(autre, { phone: t.phone })).status).toBe(201);
  });

  test('concurrence : deux créations simultanées avec le même téléphone → une seule fiche', async () => {
    const p = await nouveauProprietaire();
    const phone = telephoneUnique();
    const reponses = await Promise.all([creer(p, { phone }), creer(p, { phone }), creer(p, { phone })]);
    expect(reponses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(reponses.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await compter('tenants', 'owner_id = :o AND phone = :p', { o: p.ownerId, p: phone })).toBe(1);
  });

  test.each([
    ['prénom manquant', { first_name: undefined }],
    ['nom manquant', { last_name: undefined }],
    ['téléphone manquant', { phone: undefined }],
    ['prénom de 81 caractères', { first_name: 'f'.repeat(81) }],
    ['téléphone invalide', { phone: '12' }],
    ['e-mail invalide', { email: 'fatou@' }],
    ['type de pièce inconnu', { id_document_type: 'carte_fidelite' }],
    ['numéro de pièce de 61 caractères', { id_document_number: '9'.repeat(61) }],
    ['notes de 2001 caractères', { notes: 'n'.repeat(2001) }],
    ['consentement non booléen', { whatsapp_consent: 'oui-oui' }],
  ])('validation 422 : %s', async (_l, surcharge) => {
    const p = await nouveauProprietaire();
    const corps = { first_name: 'Fatou', last_name: 'Sarr', phone: telephoneUnique(), ...surcharge };
    for (const [cle, valeur] of Object.entries(surcharge)) if (valeur === undefined) delete corps[cle];
    expect((await api().post(URL).set(p.h).send(corps)).status).toBe(422);
    expect(await compter('tenants', 'owner_id = :o', { o: p.ownerId })).toBe(0);
  });
});

describe('Fiche, modification, suppression', () => {
  test('fiche : baux, solde, paiements récents, documents, compte et invitation en attente', async () => {
    const p = await nouveauProprietaire();
    const { tenant, lease } = await bailActif(p);
    await api().post(`${URL}/${tenant.id}/invitation`).set(p.h).send({});
    const res = await api().get(`${URL}/${tenant.id}`).set(p.h);
    expect(res.status).toBe(200);
    const f = res.body.data.tenant;
    expect(f).toMatchObject({ id: tenant.id, account_active: false, pending_invitation: { expires_at: expect.any(String) }, documents: [], recent_payments: [] });
    expect(f.leases.map((l) => l.id)).toEqual([lease.id]);
    expect(f.leases[0]).toMatchObject({ apartment: { building: expect.any(Object) }, deposit: expect.any(Object) });
    expect(f.balance).toMatchObject({ reste_du: expect.anything(), impayes: expect.anything() });
  });

  test('modification : champs, e-mail vidé → null, pièce masquée dans l’audit', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p, { id_document_type: 'passeport', id_document_number: 'A0000001' });
    const res = await api().patch(`${URL}/${t.id}`).set(p.h).send({ last_name: 'Ba', email: '', id_document_number: 'B9999999' });
    expect(res.status).toBe(200);
    expect(res.body.data.tenant).toMatchObject({ last_name: 'Ba', email: null, id_document_number: 'B9999999' });
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'locataire.modification' AND entity_id = :id", { replacements: { id: t.id } });
    expect(JSON.stringify(audit.details.id_document_number)).toContain('[masqué]');
    expect(JSON.stringify(audit.details)).not.toMatch(/A0000001|B9999999/);
  });

  test('modification : téléphone en double 409 ; téléphone verrouillé après activation du compte 409', async () => {
    const p = await nouveauProprietaire();
    const t1 = await creerLocataire(p);
    const t2 = await creerLocataire(p);
    expect((await api().patch(`${URL}/${t1.id}`).set(p.h).send({ phone: t2.phone })).status).toBe(409);
    await activerLocataire(p, t1);
    const res = await api().patch(`${URL}/${t1.id}`).set(p.h).send({ phone: telephoneUnique() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TELEPHONE_VERROUILLE');
    // Même numéro renvoyé : ce n'est pas un changement.
    expect((await api().patch(`${URL}/${t1.id}`).set(p.h).send({ phone: t1.phone, notes: 'ok' })).status).toBe(200);
  });

  test('modification : owner_id / user_id ignorés, corps vide 422', async () => {
    const p = await nouveauProprietaire();
    const autre = await nouveauProprietaire();
    const t = await creerLocataire(p);
    expect((await api().patch(`${URL}/${t.id}`).set(p.h).send({})).status).toBe(422);
    const res = await api().patch(`${URL}/${t.id}`).set(p.h).send({ notes: 'x', owner_id: autre.ownerId, user_id: autre.user.id });
    expect(res.status).toBe(200);
    const [[ligne]] = await sequelize.query('SELECT owner_id, user_id FROM tenants WHERE id = :id', { replacements: { id: t.id } });
    expect(ligne).toEqual({ owner_id: p.ownerId, user_id: null });
  });

  test('suppression : sans bail → logique + audit ; avec historique de bail → 409', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p);
    expect((await api().delete(`${URL}/${t.id}`).set(p.h)).status).toBe(200);
    expect(await compter('tenants', 'id = :id AND deleted_at IS NOT NULL', { id: t.id })).toBe(1);
    expect(await compter('audit_logs', "action = 'locataire.suppression' AND entity_id = :id", { id: t.id })).toBe(1);
    expect((await api().get(`${URL}/${t.id}`).set(p.h)).status).toBe(404);
    // Le numéro redevient disponible.
    expect((await creer(p, { phone: t.phone })).status).toBe(201);

    const { tenant } = await bailActif(p);
    const refus = await api().delete(`${URL}/${tenant.id}`).set(p.h);
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('LOCATAIRE_AVEC_HISTORIQUE');
  });
});

describe('Invitation (§ 5 option A)', () => {
  test('nouvelle invitation : la précédente est révoquée, audit', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p);
    const i1 = await api().post(`${URL}/${t.id}/invitation`).set(p.h).send({});
    expect(i1.status).toBe(201);
    expect(i1.body.data.invitation).toMatchObject({ code: expect.stringMatching(/^\d{8}$/), expires_at: expect.any(String) });
    await api().post(`${URL}/${t.id}/invitation`).set(p.h).send({});
    expect(await compter('tenant_invitations', 'tenant_id = :t AND revoked_at IS NULL AND used_at IS NULL', { t: t.id })).toBe(1);
    expect(await compter('audit_logs', "action = 'locataire.invitation' AND entity_id = :t", { t: t.id })).toBe(2);
  });

  test('locataire d’un autre propriétaire : 403 ; inconnu : 404 ; aucune invitation créée', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const t = await creerLocataire(a);
    expect((await api().post(`${URL}/${t.id}/invitation`).set(b.h).send({})).status).toBe(403);
    expect((await api().post(`${URL}/${INCONNU}/invitation`).set(b.h).send({})).status).toBe(404);
    expect(await compter('tenant_invitations', 'tenant_id = :t', { t: t.id })).toBe(0);
  });
});

describe('Consentement WhatsApp (§ 54.3, § 56.1)', () => {
  const consentir = (p, id, accorde) => api().post(`${URL}/${id}/consentement-whatsapp`).set(p.h).send({ accorde });

  test('propriétaire : déclare le consentement recueilli puis le retire ; audit', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p);
    const oui = await consentir(p, t.id, true);
    expect(oui.status).toBe(200);
    expect(oui.body.data.tenant).toMatchObject({ whatsapp_consent: true, whatsapp_consent_at: expect.any(String) });
    const non = await consentir(p, t.id, false);
    expect(non.body.data.tenant).toMatchObject({ whatsapp_consent: false, whatsapp_consent_revoked_at: expect.any(String) });
    expect(await compter('audit_logs', "action = 'locataire.consentement_whatsapp' AND entity_id = :t", { t: t.id })).toBe(2);
  });

  test('CORRECTIF : après un retrait, le propriétaire ne peut plus redonner le consentement (409 CONSENTEMENT_RETIRE)', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p, { whatsapp_consent: true });
    await consentir(p, t.id, false);
    const res = await consentir(p, t.id, true);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONSENTEMENT_RETIRE');
    const [[ligne]] = await sequelize.query('SELECT whatsapp_consent FROM tenants WHERE id = :id', { replacements: { id: t.id } });
    expect(ligne.whatsapp_consent).toBe(false);
  });

  test('CORRECTIF : retrait par le LOCATAIRE → le propriétaire ne peut pas passer outre ; seul le locataire le redonne', async () => {
    const { proprio, locataire, tenant } = await proprietaireEtLocataire();
    expect((await consentir(proprio, tenant.id, true)).status).toBe(200);
    const retrait = await api().post('/api/v1/locataire/consentement-whatsapp').set(locataire.h).send({ accorde: false });
    expect(retrait.status).toBe(200);
    expect(retrait.body.data.consents).toEqual([{ tenant_id: tenant.id, whatsapp_consent: false }]);

    const passeOutre = await consentir(proprio, tenant.id, true);
    expect(passeOutre.status).toBe(409);
    expect(passeOutre.body.error.code).toBe('CONSENTEMENT_RETIRE');
    expect(await compter('tenants', 'id = :t AND whatsapp_consent = false', { t: tenant.id })).toBe(1);

    const redonne = await api().post('/api/v1/locataire/consentement-whatsapp').set(locataire.h).send({ accorde: true });
    expect(redonne.body.data.consents).toEqual([{ tenant_id: tenant.id, whatsapp_consent: true }]);
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'locataire.consentement_whatsapp' AND entity_id = :t ORDER BY created_at DESC LIMIT 1", { replacements: { t: tenant.id } });
    expect(audit.details).toEqual({ accorde: true, par: 'locataire' });
  });

  test('déclarer un consentement déjà donné : sans effet (horodatage conservé)', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p, { whatsapp_consent: true });
    const [[avant]] = await sequelize.query('SELECT whatsapp_consent_at FROM tenants WHERE id = :id', { replacements: { id: t.id } });
    expect((await consentir(p, t.id, true)).status).toBe(200);
    const [[apres]] = await sequelize.query('SELECT whatsapp_consent_at FROM tenants WHERE id = :id', { replacements: { id: t.id } });
    expect(apres.whatsapp_consent_at).toEqual(avant.whatsapp_consent_at);
  });

  test('validation et accès : accorde manquant / non booléen 422, autre propriétaire 403', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const t = await creerLocataire(a);
    expect((await api().post(`${URL}/${t.id}/consentement-whatsapp`).set(a.h).send({})).status).toBe(422);
    expect((await consentir(a, t.id, 'peut-être')).status).toBe(422);
    expect((await consentir(b, t.id, true)).status).toBe(403);
    expect(await compter('tenants', 'id = :t AND whatsapp_consent = false', { t: t.id })).toBe(1);
  });
});

describe('Contrôle d’accès', () => {
  test('fiche d’un autre propriétaire : GET, PATCH, DELETE → 403, base inchangée', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const t = await creerLocataire(a, { id_document_type: 'cni', id_document_number: 'SECRET123' });
    for (const [methode, corps] of [['get'], ['patch', { last_name: 'Piraté' }], ['delete']]) {
      const res = await api()[methode](`${URL}/${t.id}`).set(b.h).send(corps);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('SECRET123');
    }
    const [[ligne]] = await sequelize.query('SELECT last_name, deleted_at FROM tenants WHERE id = :id', { replacements: { id: t.id } });
    expect(ligne).toEqual({ last_name: 'Ndiaye', deleted_at: null });
  });

  test('locataire et super admin : 403 sur /locataires ; anonyme 401', async () => {
    const { locataire, tenant } = await proprietaireEtLocataire();
    const admin = await superAdmin();
    for (const h of [locataire.h, admin.h]) {
      expect((await api().get(URL).set(h)).status).toBe(403);
      expect((await api().get(`${URL}/${tenant.id}`).set(h)).status).toBe(403);
      expect((await api().post(`${URL}/${tenant.id}/consentement-whatsapp`).set(h).send({ accorde: true })).status).toBe(403);
    }
    expect((await api().get(URL)).status).toBe(401);
  });

  test('404 inconnu, 422 identifiant invalide', async () => {
    const p = await nouveauProprietaire();
    expect((await api().get(`${URL}/${INCONNU}`).set(p.h)).status).toBe(404);
    expect((await api().patch(`${URL}/${INCONNU}`).set(p.h).send({ notes: 'x' })).status).toBe(404);
    expect((await api().get(`${URL}/abc`).set(p.h)).status).toBe(422);
  });
});

describe('Liste', () => {
  let p; let actif; let sansBail; let ancien; let building;
  beforeAll(async () => {
    p = await nouveauProprietaire();
    const bail = await bailActif(p);
    actif = bail.tenant;
    building = bail.building;
    sansBail = await creerLocataire(p, { first_name: 'Aïssatou', last_name: "N'Diaye_100%" });
    const autreBail = await bailActif(p);
    ancien = autreBail.tenant;
    await sequelize.query("UPDATE leases SET status = 'termine' WHERE id = :l", { replacements: { l: autreBail.lease.id } });
  });

  test('toutes les fiches, bail actif résumé, compte non activé', async () => {
    const res = await api().get(URL).set(p.h);
    expect(res.body.data.pagination.total).toBe(3);
    const ligne = res.body.data.items.find((x) => x.id === actif.id);
    expect(ligne).toMatchObject({ account_active: false, current_lease: { apartment: { building: { id: building.id } } } });
    expect(ligne).not.toHaveProperty('id_document_number');
  });

  test.each([
    ['actif', () => [actif.id]],
    ['sans_bail', () => [sansBail.id]],
    ['ancien', () => [ancien.id]],
  ])('filtre statut « %s »', async (statut, attendus) => {
    const res = await api().get(URL).query({ statut }).set(p.h);
    expect(res.body.data.items.map((x) => x.id)).toEqual(attendus());
  });

  test('filtre immeuble', async () => {
    const res = await api().get(URL).query({ building_id: building.id }).set(p.h);
    expect(res.body.data.items.map((x) => x.id)).toEqual([actif.id]);
    expect((await api().get(URL).query({ building_id: "x' OR '1'='1" }).set(p.h)).status).toBe(422);
  });

  test('recherche : accents, apostrophe, jokers littéraux ; injection sans effet', async () => {
    for (const q of ['Aïssatou', "N'D", '_100%']) {
      const res = await api().get(URL).query({ q }).set(p.h);
      expect(res.body.data.items.map((x) => x.id)).toEqual([sansBail.id]);
    }
    const avant = await compter('tenants');
    for (const q of ["' OR 1=1 --", "'; DROP TABLE tenants; --", '\\']) {
      const res = await api().get(URL).query({ q }).set(p.h);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    }
    expect(await compter('tenants')).toBe(avant);
  });

  test('pagination et tri', async () => {
    const p2 = await api().get(URL).query({ limit: 2, page: 2, tri: '-created_at' }).set(p.h);
    expect(p2.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(p2.body.data.items).toHaveLength(1);
    expect((await api().get(URL).query({ limit: 2, page: 9 }).set(p.h)).body.data.items).toEqual([]);
  });

  test.each([
    ['statut inconnu', { statut: 'expulse' }], ['tri inconnu', { tri: 'phone' }], ['page 0', { page: 0 }], ['limit abc', { limit: 'abc' }],
  ])('paramètre invalide 422 : %s', async (_l, query) => {
    expect((await api().get(URL).query(query).set(p.h)).status).toBe(422);
  });

  test('isolation : un autre propriétaire ne voit aucune de ces fiches', async () => {
    const autre = await nouveauProprietaire();
    const res = await api().get(URL).query({ q: 'Aïssatou' }).set(autre.h);
    expect(res.body.data.items).toEqual([]);
  });
});

describe('CORRECTIF M13 — notes du bailleur chiffrées au repos', () => {
  test('stockées chiffrées (AES-256-GCM), restituées en clair par l’API, modifiables', async () => {
    const p = await nouveauProprietaire();
    const note = 'Situation familiale délicate — ne pas relancer avant le 15.';
    const tenant = await creerLocataire(p, { notes: note });
    const [[brut]] = await sequelize.query('SELECT notes FROM tenants WHERE id = :t', { replacements: { t: tenant.id } });
    expect(brut.notes).toMatch(/^v1:/);
    expect(brut.notes).not.toContain('familiale');
    expect((await api().get(`/api/v1/locataires/${tenant.id}`).set(p.h)).body.data.tenant.notes).toBe(note);
    expect((await api().patch(`/api/v1/locataires/${tenant.id}`).set(p.h).send({ notes: 'Autre note' })).status).toBe(200);
    const [[apres]] = await sequelize.query('SELECT notes FROM tenants WHERE id = :t', { replacements: { t: tenant.id } });
    expect(apres.notes).toMatch(/^v1:/);
    expect((await api().get(`/api/v1/locataires/${tenant.id}`).set(p.h)).body.data.tenant.notes).toBe('Autre note');
  });
});
