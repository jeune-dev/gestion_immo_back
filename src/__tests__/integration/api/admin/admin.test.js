'use strict';

const {
  api, MOT_DE_PASSE, nouveauProprietaire, superAdmin, creerImmeuble, creerAppartement, creerLocataire,
  emailUnique, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 29 / § 30 Super Admin : tableau de bord, propriétaires, utilisateurs,
 * abonnements, plans, paramètres, notifications, catégories, modèles de bail
 * et WhatsApp, journal d'audit, rôles. Chaque mutation est journalisée (§ 40).
 */

const compter = async (sql, replacements = {}) => {
  const [[ligne]] = await sequelize.query(sql, { replacements });
  return Number(ligne.n);
};

const connecter = (identifiant) => api().post('/api/v1/auth/connexion').send({ identifiant, password: MOT_DE_PASSE });

describe('Super Admin', () => {
  let admin;

  beforeAll(async () => {
    admin = await superAdmin();
  });

  afterAll(fermer);

  test('tableau de bord : chiffres de la plateforme (premier calcul, sans cache)', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    await creerAppartement(p, b.id);
    await creerLocataire(p);

    const res = await api().get('/api/v1/admin/dashboard').set(admin.h);
    expect(res.status).toBe(200);
    const d = res.body.data.dashboard;
    expect(d.owners.total).toBe(await compter('SELECT count(*) AS n FROM owners WHERE deleted_at IS NULL'));
    expect(d.tenants).toBe(await compter('SELECT count(*) AS n FROM tenants WHERE deleted_at IS NULL'));
    expect(d.buildings).toBe(await compter('SELECT count(*) AS n FROM buildings WHERE deleted_at IS NULL'));
    expect(d.apartments.total).toBe(await compter('SELECT count(*) AS n FROM apartments WHERE deleted_at IS NULL'));
    expect(d.apartments.available).toBe(await compter("SELECT count(*) AS n FROM apartments WHERE deleted_at IS NULL AND status = 'disponible'"));
    expect(d.subscriptions.by_status.essai).toBe(await compter("SELECT count(*) AS n FROM subscriptions WHERE status = 'essai'"));
    expect(d.subscriptions.by_plan.find((x) => x.code === 'BUSINESS').count).toBeGreaterThanOrEqual(1);
    expect(d.rent).toEqual({ due: expect.any(Number), collected: expect.any(Number) });
    expect(d.payments).toMatchObject({ count: expect.any(Number), amount: expect.any(Number) });
    expect(typeof d.subscriptions.mrr).toBe('number');
  });

  test('accès réservé : un propriétaire reçoit 403 sur /admin/*, un anonyme 401', async () => {
    const p = await nouveauProprietaire();
    for (const chemin of ['/dashboard', '/proprietaires', '/plans', '/journal-audit', '/parametres']) {
      const res = await api().get(`/api/v1/admin${chemin}`).set(p.h);
      expect(res.status).toBe(403);
    }
    expect((await api().post('/api/v1/admin/notifications').set(p.h).send({ cible: 'tous', titre: 'Pirate', corps: 'Message' })).status).toBe(403);
    expect((await api().get('/api/v1/admin/dashboard')).status).toBe(401);
  });

  test('propriétaires : recherche, détail sans secret, 404', async () => {
    const p = await nouveauProprietaire();
    const liste = await api().get('/api/v1/admin/proprietaires').query({ q: p.identifiants.phone.slice(-7) }).set(admin.h);
    expect(liste.status).toBe(200);
    expect(liste.body.data.items.map((o) => o.id)).toContain(p.ownerId);
    const ligne = liste.body.data.items.find((o) => o.id === p.ownerId);
    expect(ligne).toMatchObject({ subscription_status: 'essai', plan_code: 'BUSINESS', buildings_count: 0 });

    const parPlan = await api().get('/api/v1/admin/proprietaires').query({ plan: 'BUSINESS', abonnement: 'essai', limit: 100 }).set(admin.h);
    expect(parPlan.body.data.pagination.total).toBeGreaterThanOrEqual(1);

    const detail = await api().get(`/api/v1/admin/proprietaires/${p.ownerId}`).set(admin.h);
    expect(detail.status).toBe(200);
    expect(detail.body.data.owner.titulaire.id).toBe(p.user.id);
    expect(detail.body.data.owner.subscription.plan.code).toBe('BUSINESS');
    expect(JSON.stringify(detail.body)).not.toMatch(/password_hash|token_version/);

    expect((await api().get('/api/v1/admin/proprietaires/00000000-0000-4000-8000-000000000000').set(admin.h)).status).toBe(404);
  });

  test('suspension d’un propriétaire : sessions fermées, 403 ESPACE_SUSPENDU, réactivation', async () => {
    const p = await nouveauProprietaire();
    const url = `/api/v1/admin/proprietaires/${p.ownerId}`;
    expect((await api().post(`${url}/suspendre`).set(admin.h).send({})).status).toBe(422);

    const res = await api().post(`${url}/suspendre`).set(admin.h).send({ reason: 'Impayés répétés' });
    expect(res.status).toBe(200);
    expect(res.body.data.owner.status).toBe('suspendu');
    expect((await api().post(`${url}/suspendre`).set(admin.h).send({ reason: 'Encore' })).status).toBe(409);

    // Jeton en circulation périmé (déconnexion distante)…
    expect((await api().get('/api/v1/immeubles').set(p.h)).status).toBe(401);
    // … et une nouvelle connexion ne rouvre pas l'espace.
    const session = await connecter(p.identifiants.email);
    const h = { Authorization: `Bearer ${session.body.data.access_token}` };
    const refus = await api().get('/api/v1/immeubles').set(h);
    expect(refus.status).toBe(403);
    expect(refus.body.error.code).toBe('ESPACE_SUSPENDU');

    const [audit] = await sequelize.query(
      "SELECT details FROM audit_logs WHERE action = 'proprietaire.changement_statut' AND entity_id = :id",
      { replacements: { id: p.ownerId } }
    );
    expect(audit[0].details).toMatchObject({ a: 'suspendu', motif: 'Impayés répétés' });

    expect((await api().post(`${url}/reactiver`).set(admin.h).send({})).status).toBe(200);
    expect((await api().get('/api/v1/immeubles').set(h)).status).toBe(200);
    expect((await api().post(`${url}/reactiver`).set(admin.h).send({})).status).toBe(409);
  });

  test('utilisateurs : désactivation → 403 COMPTE_INACTIF, pas sur soi-même, réactivation, déverrouillage', async () => {
    const p = await nouveauProprietaire();
    const url = `/api/v1/admin/utilisateurs/${p.user.id}`;

    const detail = await api().get(url).set(admin.h);
    expect(detail.status).toBe(200);
    expect(detail.body.data.user).toMatchObject({ id: p.user.id, is_locked: false, active_sessions: 1 });
    expect(JSON.stringify(detail.body)).not.toMatch(/password_hash|token_version|failed_login_attempts/);

    const res = await api().post(`${url}/desactiver`).set(admin.h).send({ reason: 'Demande du titulaire' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.status).toBe('inactif');
    const refus = await api().get('/api/v1/compte').set(p.h);
    expect(refus.status).toBe(403);
    expect(refus.body.error.code).toBe('COMPTE_INACTIF');
    expect((await connecter(p.identifiants.email)).body.error.code).toBe('COMPTE_INACTIF');

    const soi = await api().post(`/api/v1/admin/utilisateurs/${admin.user.id}/desactiver`).set(admin.h).send({ reason: 'Erreur de clic' });
    expect(soi.status).toBe(409);
    expect(soi.body.error.code).toBe('ACTION_SUR_SOI_INTERDITE');

    expect((await api().post(`${url}/activer`).set(admin.h).send({})).status).toBe(200);
    expect((await connecter(p.identifiants.email)).status).toBe(200);

    // Verrouillage anti force brute, levé par l'administrateur.
    await sequelize.query("UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id = :id", { replacements: { id: p.user.id } });
    const verrouilles = await api().get('/api/v1/admin/utilisateurs').query({ verrouille: true, role: 'proprietaire' }).set(admin.h);
    expect(verrouilles.body.data.items.map((u) => u.id)).toContain(p.user.id);
    expect((await api().post(`${url}/deverrouiller`).set(admin.h).send({})).body.data.user.is_locked).toBe(false);
    expect((await connecter(p.identifiants.email)).status).toBe(200);
  });

  test('création d’un super admin : politique de mot de passe, changement exigé', async () => {
    const email = emailUnique('nouvel.admin');
    const faible = await api().post('/api/v1/admin/utilisateurs').set(admin.h)
      .send({ first_name: 'Awa', last_name: 'Sow', email, password: 'Court1!', current_password: MOT_DE_PASSE });
    expect(faible.status).toBe(422);
    expect(faible.body.error.code).toBe('MOT_DE_PASSE_FAIBLE');

    const res = await api().post('/api/v1/admin/utilisateurs').set(admin.h)
      .send({ first_name: 'Awa', last_name: 'Sow', email, password: 'Xk9#vLq2!mRt', current_password: MOT_DE_PASSE });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ role_code: 'super_admin', must_change_password: true });
    expect(res.body.data.user).not.toHaveProperty('password_hash');
    const doublon = await api().post('/api/v1/admin/utilisateurs').set(admin.h)
      .send({ first_name: 'Awa', last_name: 'Sow', email, password: 'Xk9#vLq2!mRt', current_password: MOT_DE_PASSE });
    expect(doublon.status).toBe(409);
    const connexion = await api().post('/api/v1/auth/connexion').send({ identifiant: email, password: 'Xk9#vLq2!mRt' });
    expect(connexion.status).toBe(200);
  });

  test('plans : création, prix modifié visible sur les formules publiques, désactivation, suppression', async () => {
    const code = `TEST_${Date.now().toString(36).toUpperCase()}`;
    expect((await api().post('/api/v1/admin/plans').set(admin.h)
      .send({ code, name: 'Test', price: 9000, features: ['inconnue'] })).status).toBe(422);

    const creation = await api().post('/api/v1/admin/plans').set(admin.h)
      .send({ code, name: 'Formule test', price: 9000, max_buildings: 2, features: ['rapports', 'messagerie'], sort_order: 50 });
    expect(creation.status).toBe(201);
    const plan = creation.body.data.plan;
    expect((await api().post('/api/v1/admin/plans').set(admin.h).send({ code, name: 'Doublon', price: 1 })).status).toBe(409);

    const avant = await api().get('/api/v1/abonnement/plans');
    expect(Number(avant.body.data.plans.find((x) => x.code === code).price)).toBe(9000);

    const modif = await api().patch(`/api/v1/admin/plans/${plan.id}`).set(admin.h).send({ price: 12500, max_apartments: 25 });
    expect(modif.status).toBe(200);
    const apres = await api().get('/api/v1/abonnement/plans');
    expect(apres.body.data.plans.find((x) => x.code === code)).toMatchObject({ price: 12500, limits: { max_apartments: 25 } });

    expect((await api().post(`/api/v1/admin/plans/${plan.id}/desactiver`).set(admin.h).send({})).status).toBe(200);
    const masque = await api().get('/api/v1/abonnement/plans');
    expect(masque.body.data.plans.map((x) => x.code)).not.toContain(code);

    // Plan d'essai : non désactivable.
    const [[business]] = await sequelize.query("SELECT id FROM subscription_plans WHERE code = 'BUSINESS'");
    const essai = await api().post(`/api/v1/admin/plans/${business.id}/desactiver`).set(admin.h).send({});
    expect(essai.status).toBe(409);
    expect(essai.body.error.code).toBe('PLAN_ESSAI');
    // Plan référencé par des abonnements : suppression refusée.
    expect((await api().delete(`/api/v1/admin/plans/${business.id}`).set(admin.h)).status).toBe(409);

    expect((await api().delete(`/api/v1/admin/plans/${plan.id}`).set(admin.h)).status).toBe(200);
    expect((await api().get(`/api/v1/admin/plans/${plan.id}`).set(admin.h)).status).toBe(404);
  });

  test('abonnements : suspension → lecture seule (402), rétablissement, annulation, paiements', async () => {
    const p = await nouveauProprietaire();
    const liste = await api().get('/api/v1/admin/abonnements').query({ owner_id: p.ownerId }).set(admin.h);
    expect(liste.status).toBe(200);
    const abonnement = liste.body.data.items[0];
    expect(abonnement).toMatchObject({ status: 'essai', plan: { code: 'BUSINESS' } });

    const url = `/api/v1/admin/abonnements/${abonnement.id}`;
    expect((await api().post(`${url}/suspendre`).set(admin.h).send({ reason: 'Fraude suspectée' })).status).toBe(200);
    const ecriture = await api().post('/api/v1/immeubles').set(p.h).send({ name: 'Résidence Suspendue', address: 'Plateau', city: 'Dakar' });
    expect(ecriture.status).toBe(402);
    expect(ecriture.body.error.code).toBe('ABONNEMENT_REQUIS');

    const retabli = await api().post(`${url}/reactiver`).set(admin.h).send({});
    expect(retabli.body.data.subscription.status).toBe('essai');
    expect((await api().post('/api/v1/immeubles').set(p.h).send({ name: 'Résidence Rétablie', address: 'Plateau', city: 'Dakar' })).status).toBe(201);
    expect((await api().post(`${url}/reactiver`).set(admin.h).send({})).status).toBe(409);

    expect((await api().post(`${url}/annuler`).set(admin.h).send({ reason: 'Demande du client' })).body.data.subscription.status).toBe('annule');
    const detail = await api().get(url).set(admin.h);
    expect(detail.body.data.subscription).toMatchObject({ status: 'annule', owner: { id: p.ownerId } });

    await api().post(`/api/v1/admin/proprietaires/${p.ownerId}/abonnement/activer`).set(admin.h).send({ plan_code: 'STARTER', months: 1 });
    const paiements = await api().get('/api/v1/admin/paiements').query({ owner_id: p.ownerId, provider: 'manuel' }).set(admin.h);
    expect(paiements.status).toBe(200);
    expect(paiements.body.data.items).toHaveLength(1);
    expect(paiements.body.data.items[0]).not.toHaveProperty('raw_payload');

    const stats = await api().get('/api/v1/admin/paiements/loyers/statistiques').set(admin.h);
    expect(stats.status).toBe(200);
    expect(stats.body.data.statistiques).toHaveProperty('rent_payments.by_month');
    expect(Array.isArray(stats.body.data.statistiques.transactions)).toBe(true);
  });

  test('paramètres plateforme : valeurs effectives, validation par clé (422), clé inconnue (404)', async () => {
    const liste = await api().get('/api/v1/admin/parametres').set(admin.h);
    expect(liste.status).toBe(200);
    expect(liste.body.data.settings.map((s) => s.key)).toEqual(expect.arrayContaining(['essai', 'invitation', 'otp', 'paiement']));

    const invalide = await api().put('/api/v1/admin/parametres/invitation').set(admin.h).send({ duree_jours: 99 });
    expect(invalide.status).toBe(422);
    expect((await api().put('/api/v1/admin/parametres/essai').set(admin.h).send({ plan_code: 'INEXISTANT', duree_jours: 14 })).status).toBe(422);
    expect((await api().put('/api/v1/admin/parametres/inconnu').set(admin.h).send({ x: 1 })).status).toBe(404);

    const res = await api().put('/api/v1/admin/parametres/invitation').set(admin.h).send({ duree_jours: 10 });
    expect(res.status).toBe(200);
    expect(res.body.data.setting).toMatchObject({ key: 'invitation', value: { duree_jours: 10 }, customized: true });
    const [audit] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'parametre_plateforme.modification' AND entity_id = 'invitation'");
    expect(audit.at(-1).details.duree_jours).toEqual({ avant: 7, apres: 10 });
    await api().put('/api/v1/admin/parametres/invitation').set(admin.h).send({ duree_jours: 7 });
  });

  test('notification diffusée : une notification interne par propriétaire actif, historique', async () => {
    const [p1, p2] = [await nouveauProprietaire(), await nouveauProprietaire()];
    const attendus = await compter("SELECT count(*) AS n FROM users WHERE role_code = 'proprietaire' AND status = 'actif' AND deleted_at IS NULL");

    expect((await api().post('/api/v1/admin/notifications').set(admin.h).send({ cible: 'personne', titre: 'Titre', corps: 'Corps' })).status).toBe(422);
    const res = await api().post('/api/v1/admin/notifications').set(admin.h)
      .send({ cible: 'proprietaires', titre: 'Maintenance', corps: 'Maintenance prévue dimanche de 2 h à 4 h.' });
    expect(res.status).toBe(201);
    expect(res.body.data.diffusion.destinataires).toBe(attendus);

    for (const p of [p1, p2]) {
      const notifs = await api().get('/api/v1/notifications').set(p.h);
      expect(notifs.status).toBe(200);
      const items = notifs.body.data.items || notifs.body.data.notifications;
      expect(items.map((n) => n.title)).toContain('Maintenance');
    }
    expect(await compter("SELECT count(*) AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.title = 'Maintenance' AND u.role_code <> 'proprietaire'")).toBe(0);

    const historique = await api().get('/api/v1/admin/notifications').set(admin.h);
    expect(historique.status).toBe(200);
    expect(historique.body.data.items[0].details).toMatchObject({ cible: 'proprietaires', titre: 'Maintenance', destinataires: attendus });
  });

  test('modèles de bail : variable inconnue (422), publication archive la précédente, version publiée immuable (409)', async () => {
    const variables = await api().get('/api/v1/admin/modeles-bail/variables').set(admin.h);
    expect(variables.body.data.variables).toContain('bail.loyer');

    const corps = (extra = '') => `CONTRAT {{bail.reference}} entre {{bailleur.nom}} et {{locataire.nom}} : loyer {{bail.loyer}}.${extra}`;
    const inconnue = await api().post('/api/v1/admin/modeles-bail').set(admin.h)
      .send({ lease_type: 'meuble', title: 'Bail meublé', body: corps(' {{bail.pourboire}}') });
    expect(inconnue.status).toBe(422);
    expect(inconnue.body.error.code).toBe('MODELE_INVALIDE');

    const a = (await api().post('/api/v1/admin/modeles-bail').set(admin.h)
      .send({ lease_type: 'meuble', title: 'Bail meublé A', body: corps(), legal_notes: 'Validé par Me Diallo' })).body.data.template;
    expect(a).toMatchObject({ status: 'brouillon', lease_type: 'meuble' });
    const b = (await api().post('/api/v1/admin/modeles-bail').set(admin.h)
      .send({ lease_type: 'meuble', title: 'Bail meublé B', body: corps(' Annexes : {{annexes}}') })).body.data.template;
    expect(b.version).toBe(a.version + 1);

    expect((await api().patch(`/api/v1/admin/modeles-bail/${a.id}`).set(admin.h).send({ body: corps(' {{x.y}}') })).status).toBe(422);
    expect((await api().patch(`/api/v1/admin/modeles-bail/${a.id}`).set(admin.h).send({ title: 'Bail meublé A (relu)' })).status).toBe(200);

    expect((await api().post(`/api/v1/admin/modeles-bail/${a.id}/publier`).set(admin.h).send({})).body.data.template.status).toBe('publie');
    const publie = await api().post(`/api/v1/admin/modeles-bail/${b.id}/publier`).set(admin.h).send({});
    expect(publie.status).toBe(200);
    expect(publie.body.data.template).toMatchObject({ status: 'publie', published_by: admin.user.id });

    const liste = await api().get('/api/v1/admin/modeles-bail').query({ lease_type: 'meuble' }).set(admin.h);
    const statuts = Object.fromEntries(liste.body.data.templates.map((t) => [t.id, t.status]));
    expect(statuts[a.id]).toBe('archive');
    expect(statuts[b.id]).toBe('publie');
    expect(liste.body.data.templates.filter((t) => t.status === 'publie')).toHaveLength(1);
    expect(liste.body.data.templates[0]).not.toHaveProperty('body');

    const immuable = await api().patch(`/api/v1/admin/modeles-bail/${b.id}`).set(admin.h).send({ title: 'Retouche' });
    expect(immuable.status).toBe(409);
    expect(immuable.body.error.code).toBe('MODELE_IMMUABLE');
    expect((await api().post(`/api/v1/admin/modeles-bail/${a.id}/publier`).set(admin.h).send({})).status).toBe(409);
    expect((await api().post(`/api/v1/admin/modeles-bail/${a.id}/archiver`).set(admin.h).send({})).status).toBe(409);
  });

  test('modèles WhatsApp : paramètres cohérents exigés, activation', async () => {
    const liste = await api().get('/api/v1/admin/modeles-whatsapp').set(admin.h);
    const modele = liste.body.data.templates.find((m) => m.event_code === 'echeance_jour');
    const url = `/api/v1/admin/modeles-whatsapp/${modele.id}`;
    const incoherent = await api().patch(url).set(admin.h).send({ body_preview: 'Votre loyer {{1}} est dû.', variables: ['periode', 'montant'] });
    expect(incoherent.status).toBe(422);
    expect((await api().patch(url).set(admin.h).send({ meta_template_name: 'Nom Invalide' })).status).toBe(422);
    const res = await api().patch(url).set(admin.h).send({ meta_template_name: 'loyer_exigible_v2', is_active: true });
    expect(res.status).toBe(200);
    expect(res.body.data.template).toMatchObject({ meta_template_name: 'loyer_exigible_v2', is_active: true });
    await api().patch(url).set(admin.h).send({ is_active: false });
  });

  test('catégories globales : création, doublon, modification, désactivation, suppression', async () => {
    const code = `cat_${Date.now().toString(36)}`;
    const res = await api().post('/api/v1/admin/categories').set(admin.h).send({ code, name: 'Jardinage', cash_group: 'entretien', sort_order: 90 });
    expect(res.status).toBe(201);
    const id = res.body.data.category.id;
    expect(res.body.data.category.owner_id).toBeNull();
    expect((await api().post('/api/v1/admin/categories').set(admin.h).send({ code, name: 'Autre', cash_group: 'autre' })).status).toBe(409);
    expect((await api().patch(`/api/v1/admin/categories/${id}`).set(admin.h).send({ cash_group: 'inconnu' })).status).toBe(422);
    expect((await api().patch(`/api/v1/admin/categories/${id}`).set(admin.h).send({ name: 'Jardins et espaces verts' })).body.data.category.name)
      .toBe('Jardins et espaces verts');
    expect((await api().post(`/api/v1/admin/categories/${id}/desactiver`).set(admin.h).send({})).body.data.category.is_active).toBe(false);
    const inactives = await api().get('/api/v1/admin/categories').query({ is_active: false }).set(admin.h);
    expect(inactives.body.data.categories.map((c) => c.id)).toContain(id);
    expect((await api().delete(`/api/v1/admin/categories/${id}`).set(admin.h)).status).toBe(200);
    expect((await api().patch(`/api/v1/admin/categories/${id}`).set(admin.h).send({ name: 'X' })).status).toBe(404);
  });

  test('vues transverses : locataires sans pièce d’identité, immeubles, signalements, journal, rôles', async () => {
    const p = await nouveauProprietaire();
    const b = await creerImmeuble(p);
    const t = await creerLocataire(p, { id_document_type: 'cni', id_document_number: '1234567890123' });

    const locataires = await api().get('/api/v1/admin/locataires').query({ owner_id: p.ownerId }).set(admin.h);
    expect(locataires.status).toBe(200);
    const ligne = locataires.body.data.items.find((x) => x.id === t.id);
    expect(ligne).toMatchObject({ owner: { id: p.ownerId }, has_account: false });
    expect(JSON.stringify(locataires.body)).not.toMatch(/id_document|1234567890123|notes/);
    const recherche = await api().get('/api/v1/admin/locataires').query({ q: `${t.first_name} ${t.last_name}`, owner_id: p.ownerId }).set(admin.h);
    expect(recherche.body.data.items.map((x) => x.id)).toContain(t.id);

    const immeubles = await api().get('/api/v1/admin/immeubles').query({ owner_id: p.ownerId }).set(admin.h);
    expect(immeubles.body.data.items[0]).toMatchObject({ id: b.id, apartments_count: 0, owner: { id: p.ownerId } });

    expect((await api().get('/api/v1/admin/signalements').set(admin.h)).status).toBe(200);
    const stats = await api().get('/api/v1/admin/signalements/statistiques').set(admin.h);
    expect(stats.body.data.statistiques).toMatchObject({ total: expect.any(Number), by_status: expect.any(Object) });

    const journal = await api().get('/api/v1/admin/journal-audit').query({ owner_id: p.ownerId, action: 'immeuble.' }).set(admin.h);
    expect(journal.status).toBe(200);
    expect(journal.body.data.items[0]).toMatchObject({ action: 'immeuble.creation', entity_id: b.id });
    expect((await api().get('/api/v1/admin/journal-audit').query({ du: '2026-13-01' }).set(admin.h)).status).toBe(422);

    const roles = await api().get('/api/v1/admin/roles').set(admin.h);
    expect(roles.status).toBe(200);
    expect(roles.body.data.roles.map((r) => r.code)).toEqual(expect.arrayContaining(['super_admin', 'proprietaire', 'locataire']));
    expect(roles.body.data.catalogue).toContain('admin.roles');
  });
});
