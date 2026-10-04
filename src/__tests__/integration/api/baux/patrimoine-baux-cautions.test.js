'use strict';

const sharp = require('sharp');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, creerLocataire, bailActif, activerLocataire,
  desactiverEdlObligatoire, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * Patrimoine (§ 7–10), règles § 41, cycle de la caution (§ 55), contrat
 * généré (§ 53), relances (§ 14) — et le test critique § 43.
 */
describe('Patrimoine, baux et cautions', () => {
  afterAll(fermer);

  test('§ 43 TEST CRITIQUE : le propriétaire A tente d’accéder à l’appartement du propriétaire B → 403', async () => {
    const a = await nouveauProprietaire();
    const b = await nouveauProprietaire();
    const immeubleB = await creerImmeuble(b);
    const appartB = await creerAppartement(b, immeubleB.id);
    const locB = await creerLocataire(b);
    for (const [methode, url, corps] of [
      ['get', `/api/v1/appartements/${appartB.id}`],
      ['patch', `/api/v1/appartements/${appartB.id}`, { rent_amount: 1 }],
      ['delete', `/api/v1/appartements/${appartB.id}`],
      ['get', `/api/v1/appartements/${appartB.id}/historique`],
      ['get', `/api/v1/immeubles/${immeubleB.id}`],
      ['get', `/api/v1/locataires/${locB.id}`],
    ]) {
      const res = await api()[methode](url).set(a.h).send(corps);
      expect(res.status).toBe(403);
    }
    // Référencer la ressource d'autrui dans un corps de requête : 403 aussi.
    const vol = await api().post('/api/v1/appartements').set(a.h).send({ building_id: immeubleB.id, number: 'X1', type: 'f2', rent_amount: 1000 });
    expect(vol.status).toBe(403);
    const bail = await api().post('/api/v1/baux').set(a.h).send({ apartment_id: appartB.id, tenant_id: locB.id, start_date: '2026-10-01' });
    expect(bail.status).toBe(403);
    // Les listes ne mélangent jamais les espaces.
    const liste = await api().get('/api/v1/appartements').set(a.h);
    expect(liste.body.data.items.find((x) => x.id === appartB.id)).toBeUndefined();
  });

  test('immeuble : création, liste avec statistiques d’occupation, suppression refusée s’il contient des appartements', async () => {
    const p = await nouveauProprietaire();
    const immeuble = await creerImmeuble(p, { name: 'Résidence Almadies' });
    await creerAppartement(p, immeuble.id, { number: 'A01' });
    const liste = await api().get('/api/v1/immeubles?q=almadies').set(p.h);
    expect(liste.body.data.items[0]).toMatchObject({ name: 'Résidence Almadies', apartments_count: 1, available_count: 1 });
    expect((await api().delete(`/api/v1/immeubles/${immeuble.id}`).set(p.h)).status).toBe(409);
    expect((await api().post('/api/v1/immeubles').set(p.h).send({ name: 'Résidence Almadies', address: 'x', city: 'Dakar' })).status).toBe(409);
  });

  test('limite de la formule : au-delà du nombre d’immeubles du plan → 403 LIMITE_ABONNEMENT', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = 'STARTER') WHERE owner_id = :o", { replacements: { o: p.ownerId } });
    await require('../../../../modules/abonnement/service/droits.service.js').invalider(p.ownerId);
    await creerImmeuble(p);
    const res = await api().post('/api/v1/immeubles').set(p.h).send({ name: 'Deuxième', address: 'x', city: 'Dakar' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('LIMITE_ABONNEMENT');
  });

  test('abonnement expiré : lecture seule (GET 200, écriture 402)', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE subscriptions SET current_period_end = '2020-01-01', current_period_start = '2019-12-01' WHERE owner_id = :o", { replacements: { o: p.ownerId } });
    await require('../../../../modules/abonnement/service/droits.service.js').invalider(p.ownerId);
    expect((await api().get('/api/v1/immeubles').set(p.h)).status).toBe(200);
    const res = await api().post('/api/v1/immeubles').set(p.h).send({ name: 'Bloqué', address: 'x', city: 'Dakar' });
    expect(res.status).toBe(402);
    // Le renouvellement reste accessible.
    expect((await api().get('/api/v1/abonnement').set(p.h)).status).toBe(200);
  });

  test('§ 41 un appartement occupé a un locataire actif : statut piloté par le bail', async () => {
    const p = await nouveauProprietaire();
    const { lease, apartment, tenant } = await bailActif(p);
    let appart = (await api().get(`/api/v1/appartements/${apartment.id}`).set(p.h)).body.data.apartment;
    expect(appart.status).toBe('occupe');
    expect(appart.current_tenant.id).toBe(tenant.id);
    expect((await api().patch(`/api/v1/appartements/${apartment.id}/statut`).set(p.h).send({ status: 'disponible' })).status).toBe(409);
    // Un second bail sur le même appartement ne peut pas être activé.
    const autre = await creerLocataire(p);
    const b2 = await api().post('/api/v1/baux').set(p.h).send({ apartment_id: apartment.id, tenant_id: autre.id, start_date: '2026-11-01' });
    expect((await api().post(`/api/v1/baux/${b2.body.data.lease.id}/activer`).set(p.h)).body.error.code).toBe('APPARTEMENT_OCCUPE');
    // Fin de bail : appartement libéré, échéances futures non payées annulées.
    const fin = await api().post(`/api/v1/baux/${lease.id}/terminer`).set(p.h).send({ ended_on: '2026-10-31' });
    expect(fin.status).toBe(200);
    appart = (await api().get(`/api/v1/appartements/${apartment.id}`).set(p.h)).body.data.apartment;
    expect(appart.status).toBe('disponible');
    const [[{ n }]] = await sequelize.query("SELECT count(*)::int AS n FROM rent_schedules WHERE lease_id = :l AND period_start > '2026-10-31' AND status <> 'annule'", { replacements: { l: lease.id } });
    expect(n).toBe(0);
  });

  test('modification du loyer d’un bail actif : échéances futures non payées recalculées, audit « modification_loyer »', async () => {
    const p = await nouveauProprietaire();
    const { lease } = await bailActif(p);
    const res = await api().post(`/api/v1/baux/${lease.id}/loyer`).set(p.h).send({ rent_amount: 400000, effective_from: '2027-01-01' });
    expect(res.status).toBe(200);
    const [[jan]] = await sequelize.query("SELECT amount_due FROM rent_schedules WHERE lease_id = :l AND period_start = '2027-01-01'", { replacements: { l: lease.id } });
    const [[dec]] = await sequelize.query("SELECT amount_due FROM rent_schedules WHERE lease_id = :l AND period_start = '2026-12-01'", { replacements: { l: lease.id } });
    expect(jan.amount_due).toBe(400000);
    expect(dec.amount_due).toBe(350000);
    const [[a]] = await sequelize.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'bail.modification_loyer' AND entity_id = :l", { replacements: { l: lease.id } });
    expect(a.n).toBe(1);
  });

  test('§ 53 contrat : refusé tant que le modèle n’est pas publié ; généré, versionné, partagé ; nouveau modèle sans effet sur l’existant', async () => {
    const p = await nouveauProprietaire();
    const { lease, tenant } = await bailActif(p);
    // Modèles = données PLATEFORME partagées par les fichiers du worker (ordre
    // aléatoire) : état « aucun modèle habitation publié » posé ici, état
    // antérieur rétabli à la fin.
    const [dejaPublies] = await sequelize.query("UPDATE lease_templates SET status = 'brouillon' WHERE lease_type = 'habitation' AND status = 'publie' RETURNING id");
    try {
    const refus = await api().post(`/api/v1/baux/${lease.id}/contrats`).set(p.h).send({});
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('MODELE_NON_PUBLIE');

    await sequelize.query("UPDATE lease_templates SET status = 'publie', published_at = now() WHERE lease_type = 'habitation' AND version = 1");
    const res = await api().post(`/api/v1/baux/${lease.id}/contrats`).set(p.h).send({ special_clauses: 'Animaux interdits.' });
    expect(res.status).toBe(201);
    const [[doc]] = await sequelize.query('SELECT content, template_version, special_clauses FROM lease_documents WHERE lease_id = :l', { replacements: { l: lease.id } });
    expect(doc.template_version).toBe(1);
    expect(doc.content).toContain(`${tenant.first_name} ${tenant.last_name}`);
    expect(doc.content).toContain('350 000 FCFA');
    expect(doc.content).not.toMatch(/\{\{/);
    // Le texte du modèle change : le contrat existant garde son contenu figé.
    await sequelize.query("UPDATE lease_templates SET body = body || ' MODIFIÉ' WHERE lease_type = 'habitation' AND version = 1");
    const [[apres]] = await sequelize.query('SELECT content FROM lease_documents WHERE lease_id = :l', { replacements: { l: lease.id } });
    expect(apres.content).toBe(doc.content);
    await sequelize.query("UPDATE lease_templates SET status = 'brouillon', body = replace(body, ' MODIFIÉ', '') WHERE lease_type = 'habitation' AND version = 1");

    const loc = await activerLocataire(p, tenant);
    const docs = await api().get(`/api/v1/documents?entity_type=lease&entity_id=${lease.id}`).set(loc.h);
    expect(docs.body.data.documents || docs.body.data.items).toBeDefined();
    } finally {
      await sequelize.query("UPDATE lease_templates SET status = 'brouillon', body = replace(body, ' MODIFIÉ', '') WHERE lease_type = 'habitation' AND version = 1");
      if (dejaPublies.length) await sequelize.query("UPDATE lease_templates SET status = 'publie' WHERE id IN (:ids)", { replacements: { ids: dejaPublies.map((l) => l.id) } });
    }
  });

  describe('§ 55 caution', () => {
    async function preparer() {
      const p = await nouveauProprietaire();
      const bail = await bailActif(p);
      const [[{ id }]] = await sequelize.query('SELECT id FROM deposits WHERE lease_id = :l', { replacements: { l: bail.lease.id } });
      return { p, ...bail, depositId: id };
    }

    test('versements : partiel puis détenue ; hors revenus ; dépassement refusé', async () => {
      const { p, depositId } = await preparer();
      const v1 = await api().post(`/api/v1/cautions/${depositId}/versements`).set(p.h).send({ amount: 300000, occurred_on: '2026-09-01', method: 'especes' });
      expect(v1.body.data.deposit.status).toBe('partiellement_versee');
      const v2 = await api().post(`/api/v1/cautions/${depositId}/versements`).set(p.h).send({ amount: 400000, occurred_on: '2026-09-02', method: 'wave' });
      expect(v2.body.data.deposit.status).toBe('detenue');
      expect((await api().post(`/api/v1/cautions/${depositId}/versements`).set(p.h).send({ amount: 1, occurred_on: '2026-09-03', method: 'especes' })).status).toBe(422);
      const synthese = await api().get('/api/v1/caisse/synthese?du=2026-09-01&au=2026-09-30').set(p.h);
      expect(synthese.body.data.caisse.entrees).toBe(0);
      expect(synthese.body.data.caisse.cautions.recues).toBe(700000);
    });

    test('décompte : retenue sans justificatif refusée ; contestation → litige → clôture bloquée puis documentée ; restitution', async () => {
      const { p, lease, tenant, depositId } = await preparer();
      await api().post(`/api/v1/cautions/${depositId}/versements`).set(p.h).send({ amount: 700000, occurred_on: '2026-09-01', method: 'especes' });
      // Retenue impossible pendant le bail.
      await api().post(`/api/v1/baux/${lease.id}/terminer`).set(p.h).send({ ended_on: '2026-12-31' });

      const sans = await api().post(`/api/v1/cautions/${depositId}/retenues`).set(p.h).send({ amount: 100000, reason: 'degradation', description: 'Porte cassée', justification_document_ids: [] });
      expect(sans.status).toBe(422);

      const photo = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).png().toBuffer();
      const j = await api().post(`/api/v1/cautions/${depositId}/justificatifs`).set(p.h).attach('fichier', photo, 'porte.png');
      expect(j.status).toBe(201);
      const r = await api().post(`/api/v1/cautions/${depositId}/retenues`).set(p.h)
        .send({ amount: 100000, reason: 'degradation', description: 'Porte cassée', justification_document_ids: [j.body.data.document.id] });
      expect(r.status).toBe(201);
      expect(r.body.data.deposit.status).toBe('retenue_partielle');

      const loc = await activerLocataire(p, tenant);
      const c = await api().post(`/api/v1/locataire/caution/retenues/${r.body.data.transaction.id}/contester`).set(loc.h)
        .send({ message: 'La porte était déjà abîmée à l’entrée.' });
      expect(c.status).toBe(200);
      expect(c.body.data.deposit.status).toBe('litige');
      expect((await api().post(`/api/v1/baux/${lease.id}/cloturer`).set(p.h)).body.error.code).toBe('CAUTION_NON_SOLDEE');

      const rep = await api().post(`/api/v1/cautions/${depositId}/retenues/${r.body.data.transaction.id}/reponse`).set(p.h)
        .send({ response: 'Photos de l’état des lieux de sortie à l’appui.', outcome: 'ajustee', adjusted_amount: 50000 });
      expect(rep.body.data.deposit.amount_withheld).toBe(50000);
      const rest = await api().post(`/api/v1/cautions/${depositId}/restitutions`).set(p.h).send({ amount: 650000, occurred_on: '2027-01-10', method: 'wave' });
      expect(rest.body.data.deposit.status).toBe('restituee');
      expect((await api().post(`/api/v1/baux/${lease.id}/cloturer`).set(p.h)).status).toBe(200);
      const mine = await api().get('/api/v1/locataire/caution').set(loc.h);
      expect(mine.body.data.deposits[0].balance).toBe(0);
    });

    test('un autre propriétaire ne peut pas opérer sur la caution (403)', async () => {
      const { depositId } = await preparer();
      const autre = await nouveauProprietaire();
      expect((await api().post(`/api/v1/cautions/${depositId}/versements`).set(autre.h).send({ amount: 1000, occurred_on: '2026-09-01', method: 'especes' })).status).toBe(403);
    });
  });

  test('§ 14 relances : une seule par échéance et par délai, même si le job repasse', async () => {
    const p = await nouveauProprietaire();
    const { lease } = await bailActif(p);
    const relances = require('../../../../modules/loyer/service/relance.service.js');
    const [[e]] = await sequelize.query("SELECT id, due_date FROM rent_schedules WHERE lease_id = :l ORDER BY due_date LIMIT 1", { replacements: { l: lease.id } });
    // Jour = échéance + 3 → relance de retard niveau 1.
    const jour = new Date(Date.parse(`${e.due_date}T00:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10);
    await relances.envoyerRelances(jour);
    await relances.envoyerRelances(jour);
    const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM rent_reminders WHERE rent_schedule_id = :id', { replacements: { id: e.id } });
    expect(n).toBe(1);
    const [[notif]] = await sequelize.query("SELECT count(*)::int AS n FROM notifications WHERE type = 'retard_loyer' AND data->>'rent_schedule_id' = :id", { replacements: { id: e.id } });
    expect(notif.n).toBeGreaterThanOrEqual(1);
  });

  test('job des statuts : une échéance échue passe « en retard » en une requête', async () => {
    const p = await nouveauProprietaire();
    await desactiverEdlObligatoire(p);
    const { lease } = await bailActif(p, { bail: { start_date: '2026-01-01' } });
    await sequelize.query("UPDATE rent_schedules SET status = 'a_venir' WHERE lease_id = :l", { replacements: { l: lease.id } });
    await require('../../../../modules/loyer/service/echeance.service.js').mettreAJourStatuts('2026-03-10');
    const [lignes] = await sequelize.query("SELECT status FROM rent_schedules WHERE lease_id = :l AND due_date < '2026-03-10'", { replacements: { l: lease.id } });
    expect(lignes.every((l) => l.status === 'en_retard')).toBe(true);
  });

  test('historique d’un appartement (§ 25) et rentabilité : caution exclue', async () => {
    const p = await nouveauProprietaire();
    const { lease, apartment } = await bailActif(p);
    await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, amount: 350000, paid_on: '2026-09-23' });
    const h = await api().get(`/api/v1/appartements/${apartment.id}/historique`).set(p.h);
    expect(h.body.data.items[0]).toMatchObject({ type: 'loyer_paye', montant: 350000 });
    const r = await api().get(`/api/v1/appartements/${apartment.id}/rentabilite?du=2026-09-01&au=2026-09-30`).set(p.h);
    expect(r.body.data.rentabilite).toMatchObject({ loyers_encaisses: 350000, resultat_net: 350000 });
  });
});
