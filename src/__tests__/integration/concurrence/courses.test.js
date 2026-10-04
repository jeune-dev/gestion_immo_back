'use strict';

const {
  api, MOT_DE_PASSE, nouveauProprietaire, creerImmeuble, creerAppartement, creerLocataire, desactiverEdlObligatoire,
  bailActif, echeancesDu, telephoneUnique, emailUnique, compter, fermer, sequelize,
} = require('../../setup/helpers.js');
const { executerJob } = require('../../../jobs/executerJob.js');

/**
 * CONCURRENCE : deux requêtes simultanées sur la même ressource ne doivent
 * jamais produire de doublon, de solde faux ni d'état impossible (§ 44
 * « double clic », § 45 « opérations financières idempotentes »).
 *
 * Chaque test lance les requêtes EN MÊME TEMPS (Promise.all) puis vérifie
 * l'état de la base, qui est la seule vérité.
 */
describe('Courses critiques', () => {
  afterAll(fermer);

  test('deux activations simultanées de deux baux sur le MÊME appartement : un seul bail actif', async () => {
    const p = await nouveauProprietaire();
    await desactiverEdlObligatoire(p);
    const b = await creerImmeuble(p);
    const a = await creerAppartement(p, b.id);
    const [t1, t2] = await Promise.all([creerLocataire(p), creerLocataire(p)]);
    const [l1, l2] = await Promise.all([t1, t2].map((t) => api().post('/api/v1/baux').set(p.h)
      .send({ apartment_id: a.id, tenant_id: t.id, start_date: '2026-10-01' }).then((r) => r.body.data.lease)));
    const resultats = await Promise.all([l1, l2].map((l) => api().post(`/api/v1/baux/${l.id}/activer`).set(p.h)));
    expect(resultats.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await compter('leases', "apartment_id = :a AND status = 'actif'", { a: a.id })).toBe(1);
    // Les échéances n'existent que pour le bail gagnant.
    const gagnant = resultats[0].status === 200 ? l1 : l2;
    const perdant = gagnant === l1 ? l2 : l1;
    expect(await compter('rent_schedules', 'lease_id = :l', { l: perdant.id })).toBe(0);
    expect(await compter('rent_schedules', 'lease_id = :l', { l: gagnant.id })).toBeGreaterThan(0);
  });

  test('deux inscriptions simultanées avec le même téléphone : un seul compte', async () => {
    const phone = telephoneUnique();
    const corps = () => ({ first_name: 'A', last_name: 'B', phone, email: emailUnique(), password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE });
    const res = await Promise.all([1, 2, 3].map(() => api().post('/api/v1/auth/inscription').send(corps())));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(await compter('users', 'phone = :p', { p: phone })).toBe(1);
    expect(await compter('owners', 'phone = :p', { p: phone })).toBe(1);
  });

  test('le même code d’invitation utilisé deux fois en même temps : un seul compte locataire', async () => {
    const p = await nouveauProprietaire();
    const t = await creerLocataire(p);
    const inv = (await api().post(`/api/v1/locataires/${t.id}/invitation`).set(p.h)).body.data.invitation;
    const activer = () => api().post('/api/v1/auth/locataire/activation')
      .send({ code: inv.code, phone: t.phone, password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE });
    const res = await Promise.all([activer(), activer()]);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await compter('users', "phone = :p AND role_code = 'locataire'", { p: t.phone })).toBe(1);
  });

  test('deux encaissements simultanés sur la même échéance : jamais plus que le dû, total cohérent', async () => {
    const p = await nouveauProprietaire();
    const { lease } = await bailActif(p, { bail: { end_date: '2026-10-31' } });
    const [e] = await echeancesDu(p, lease.id);
    const res = await Promise.all([1, 2, 3].map(() => api().post('/api/v1/paiements/especes').set(p.h)
      .send({ lease_id: lease.id, rent_schedule_id: e.id, amount: 300000, paid_on: '2026-09-05' })));
    const [[etat]] = await sequelize.query(`
      SELECT (SELECT coalesce(sum(amount_paid), 0) FROM rent_schedules WHERE lease_id = :l)::int AS impute,
             (SELECT coalesce(sum(amount), 0) FROM rent_payments WHERE lease_id = :l AND status = 'valide')::int AS encaisse,
             (SELECT coalesce(sum(amount_due), 0) FROM rent_schedules WHERE lease_id = :l)::int AS du,
             (SELECT bool_and(amount_paid <= amount_due) FROM rent_schedules WHERE lease_id = :l) AS jamais_trop`,
    { replacements: { l: lease.id } });
    expect(etat.jamais_trop).toBe(true);
    expect(etat.impute).toBe(etat.encaisse);
    expect(etat.encaisse).toBeLessThanOrEqual(etat.du);
    // Les encaissements qui ne tenaient plus dans le dû ont été refusés, sans trace.
    expect(res.filter((r) => r.status === 201).length * 300000).toBe(etat.encaisse);
  });

  test('deux remboursements simultanés du même paiement : un seul remboursement, une seule sortie de caisse', async () => {
    const p = await nouveauProprietaire();
    const { lease } = await bailActif(p);
    const pay = (await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, amount: 350000, paid_on: '2026-09-05' })).body.data.payment;
    const res = await Promise.all([1, 2].map(() => api().post(`/api/v1/paiements/${pay.id}/rembourser`).set(p.h).send({ reason: 'Doublon' })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await compter('cash_movements', "source_id = :p AND category = 'remboursement'", { p: pay.id })).toBe(1);
  });

  test('une tâche planifiée lancée deux fois en même temps ne s’exécute qu’une fois (verrou PostgreSQL)', async () => {
    let executions = 0;
    const tache = async () => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 300));
      return 'fait';
    };
    const [a, b] = await Promise.all([executerJob('test-verrou', tache), executerJob('test-verrou', tache)]);
    expect(executions).toBe(1);
    expect([a, b].sort()).toEqual(['fait', null].sort());
    // Le verrou est libéré : une exécution suivante passe.
    expect(await executerJob('test-verrou', tache)).toBe('fait');
  });

  test('création simultanée d’immeubles à la limite de la formule : jamais au-delà', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = 'STARTER') WHERE owner_id = :o", { replacements: { o: p.ownerId } });
    await require('../../../modules/abonnement/service/droits.service.js').invalider(p.ownerId);
    const res = await Promise.all([1, 2, 3, 4].map((i) => api().post('/api/v1/immeubles').set(p.h).send({ name: `Course ${i}`, address: 'x', city: 'Dakar' })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await compter('buildings', 'owner_id = :o AND deleted_at IS NULL', { o: p.ownerId })).toBe(1);
  });
});
