'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  nouveauProprietaire, bailActif, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const logger = require('../../../../utils/logger.js');
const { executerJob, cleVerrou } = require('../../../../jobs/executerJob.js');
const { nettoyer } = require('../../../../jobs/nettoyage.js');
const { TACHES } = require('../../../../jobs/index.js');
const relances = require('../../../../modules/loyer/service/relance.service.js');

/**
 * Tâches planifiées (src/jobs) :
 *   - executerJob : verrou consultatif PostgreSQL (jamais deux exécutions
 *     simultanées d'une même tâche), erreur journalisée et JAMAIS propagée ;
 *   - nettoyage : purge des données techniques échues, par lots ;
 *   - chaque tâche du planificateur s'exécute sans erreur sur une base peuplée ;
 *   - relances (§ 14) : toutes les relances du jour partent, par lots
 *     ordonnés, une seule fois chacune (audit #11 : `LIMIT 5000` sans ORDER BY
 *     ni reprise → au-delà de 5000 échéances, relances jamais envoyées).
 */

jest.setTimeout(120000);

const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** Promesse résolue « de l'extérieur » : tient une tâche en cours le temps du test. */
function barriere() {
  let liberer;
  const promesse = new Promise((resolve) => { liberer = resolve; });
  return { promesse, liberer };
}

afterAll(fermer);

describe('executerJob — verrou consultatif et robustesse', () => {
  test('une seconde exécution SIMULTANÉE de la même tâche est ignorée (null) ; la première aboutit', async () => {
    const nom = `test-verrou-${crypto.randomBytes(4).toString('hex')}`;
    const tenue = barriere();
    const demarree = barriere();
    let appelsSecond = 0;

    const premiere = executerJob(nom, async () => {
      demarree.liberer();
      await tenue.promesse;
      return { traite: 3 };
    });
    await demarree.promesse; // la première tâche détient le verrou

    const seconde = await executerJob(nom, async () => { appelsSecond += 1; return 'ne doit pas tourner'; });
    expect(seconde).toBeNull();
    expect(appelsSecond).toBe(0);

    tenue.liberer();
    await expect(premiere).resolves.toEqual({ traite: 3 });

    // Verrou relâché : une nouvelle exécution passe.
    await expect(executerJob(nom, async () => 'ok')).resolves.toBe('ok');
  });

  test('deux tâches de NOMS différents tournent en parallèle (verrous distincts)', async () => {
    const tenue = barriere();
    const a = executerJob(`test-a-${crypto.randomUUID()}`, async () => { await tenue.promesse; return 'a'; });
    const b = await executerJob(`test-b-${crypto.randomUUID()}`, async () => 'b');
    expect(b).toBe('b');
    tenue.liberer();
    expect(await a).toBe('a');
    expect(cleVerrou('x')).not.toBe(cleVerrou('y'));
    expect(cleVerrou('x')).toBe(cleVerrou('x'));
  });

  test('une erreur dans la tâche est journalisée et renvoie null sans être propagée ; le verrou est relâché', async () => {
    const nom = `test-erreur-${crypto.randomBytes(4).toString('hex')}`;
    const espion = jest.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const resultat = await executerJob(nom, async () => { throw new Error('panne simulée'); });
      expect(resultat).toBeNull();
      expect(espion).toHaveBeenCalledWith(expect.stringContaining('panne simulée'), expect.objectContaining({ stack: expect.any(String) }));
    } finally {
      espion.mockRestore();
    }
    // Le verrou a bien été relâché malgré l'erreur.
    await expect(executerJob(nom, async () => 42)).resolves.toBe(42);
    // Une autre session obtient le verrou : il n'est détenu par personne.
    const libre = await sequelize.transaction(async (t) => {
      const [{ ok }] = await sequelize.query('SELECT pg_try_advisory_xact_lock(CAST(:cle AS bigint)) AS ok', {
        replacements: { cle: cleVerrou(nom).toString() }, type: QueryTypes.SELECT, transaction: t,
      });
      return ok;
    });
    expect(libre).toBe(true);
  });
});

describe('nettoyage des données techniques', () => {
  let proprio;
  beforeAll(async () => { proprio = await nouveauProprietaire(); });

  const hash = () => crypto.randomBytes(32).toString('hex');

  test('supprime les lignes échues de chaque table et conserve les lignes valides', async () => {
    const u = proprio.user.id;
    const b = await bailActif(proprio);
    const ins = (sql, r = {}) => q(`${sql} RETURNING id`, { u, ...r }).then(([l]) => l.id);

    const echus = {
      refresh_expire: await ins("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (:u, :h, now() - interval '31 days')", { h: hash() }),
      refresh_revoque: await ins("INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked_at) VALUES (:u, :h, now() + interval '1 day', now() - interval '31 days')", { h: hash() }),
      idem: await ins("INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, expires_at) VALUES (:u, :k, 'POST', '/x', :h, now() - interval '1 minute')", { k: hash(), h: hash() }),
      reset: await ins("INSERT INTO password_resets (user_id, otp_hash, expires_at, created_at) VALUES (:u, :h, now(), now() - interval '25 hours')", { h: hash() }),
      invitation: await ins("INSERT INTO tenant_invitations (owner_id, tenant_id, token_hash, code_hash, expires_at, created_at) VALUES (:o, :t, :h, :h2, now() - interval '91 days', now() - interval '100 days')", { o: proprio.ownerId, t: b.tenant.id, h: hash(), h2: hash() }),
      notif: await ins("INSERT INTO notifications (user_id, type, title, body, read_at, created_at) VALUES (:u, 'incident', 'x', 'y', now() - interval '13 months', now() - interval '13 months')"),
    };
    const valides = {
      refresh: await ins("INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked_at) VALUES (:u, :h, now() - interval '29 days', now() - interval '29 days')", { h: hash() }),
      idem: await ins("INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, expires_at) VALUES (:u, :k, 'POST', '/x', :h, now() + interval '1 hour')", { k: hash(), h: hash() }),
      reset: await ins("INSERT INTO password_resets (user_id, otp_hash, expires_at, created_at) VALUES (:u, :h, now(), now() - interval '23 hours')", { h: hash() }),
      invitation: await ins("INSERT INTO tenant_invitations (owner_id, tenant_id, token_hash, code_hash, expires_at) VALUES (:o, :t, :h, :h2, now() - interval '89 days')", { o: proprio.ownerId, t: b.tenant.id, h: hash(), h2: hash() }),
      // Non lue : jamais purgée, même ancienne ; lue récente : conservée.
      notif_non_lue: await ins("INSERT INTO notifications (user_id, type, title, body, created_at) VALUES (:u, 'incident', 'x', 'y', now() - interval '24 months')"),
      notif_lue_recente: await ins("INSERT INTO notifications (user_id, type, title, body, read_at, created_at) VALUES (:u, 'incident', 'x', 'y', now(), now() - interval '11 months')"),
    };

    const bilan = await nettoyer();
    expect(Object.keys(bilan).sort()).toEqual(['idempotency_keys', 'notifications', 'password_resets', 'refresh_tokens', 'tenant_invitations']);
    expect(bilan.refresh_tokens).toBeGreaterThanOrEqual(2);
    for (const n of Object.values(bilan)) expect(n).toBeGreaterThanOrEqual(1);

    const existe = async (table, id) => (await compter(table, 'id = :id', { id })) === 1;
    expect(await existe('refresh_tokens', echus.refresh_expire)).toBe(false);
    expect(await existe('refresh_tokens', echus.refresh_revoque)).toBe(false);
    expect(await existe('idempotency_keys', echus.idem)).toBe(false);
    expect(await existe('password_resets', echus.reset)).toBe(false);
    expect(await existe('tenant_invitations', echus.invitation)).toBe(false);
    expect(await existe('notifications', echus.notif)).toBe(false);

    expect(await existe('refresh_tokens', valides.refresh)).toBe(true);
    expect(await existe('idempotency_keys', valides.idem)).toBe(true);
    expect(await existe('password_resets', valides.reset)).toBe(true);
    expect(await existe('tenant_invitations', valides.invitation)).toBe(true);
    expect(await existe('notifications', valides.notif_non_lue)).toBe(true);
    expect(await existe('notifications', valides.notif_lue_recente)).toBe(true);

    // Données métier jamais touchées.
    expect(await compter('leases', 'id = :id', { id: b.lease.id })).toBe(1);
    // Rien de plus à purger : un second passage ne supprime rien de ce test.
    await nettoyer();
    expect(await existe('idempotency_keys', valides.idem)).toBe(true);
  });

  test('boucle de lots : tout est purgé par lots successifs ; le nombre de lots est borné', async () => {
    const u = proprio.user.id;
    const inserer = (n) => q(`
      INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, expires_at)
      SELECT :u, 'lot-' || md5(random()::text || g), 'POST', '/lot', md5(g::text) || md5(g::text), now() - interval '1 hour'
        FROM generate_series(1, :n) g`, { u, n });
    const restants = () => compter('idempotency_keys', "expires_at < now()");

    await inserer(7);
    const bilan = await nettoyer({ taille: 2 });
    expect(bilan.idempotency_keys).toBeGreaterThanOrEqual(7);
    expect(await restants()).toBe(0);

    // Borne : 2 lots de 2 → 4 lignes au plus, le reste attend le passage suivant.
    await inserer(7);
    const borne = await nettoyer({ taille: 2, lotsMax: 2 });
    expect(borne.idempotency_keys).toBe(4);
    expect(await restants()).toBe(3);
    await nettoyer({ taille: 2 });
    expect(await restants()).toBe(0);
  });
});

describe('planificateur : chaque tâche s’exécute sans erreur sur une base peuplée', () => {
  beforeAll(async () => {
    // Base peuplée : propriétaire, bail actif (échéances), demande de paiement expirée.
    const p = await nouveauProprietaire();
    const b = await bailActif(p);
    await q(`
      INSERT INTO payment_transactions (owner_id, tenant_id, lease_id, provider, mode, reference, amount, status, expires_at, initiated_by)
      VALUES (:o, :t, :l, 'paydunya', 'integre', :ref, 1000, 'initiee', now() - interval '1 hour', :u)`,
    { o: p.ownerId, t: b.tenant.id, l: b.lease.id, ref: `TST-${crypto.randomBytes(6).toString('hex')}`, u: p.user.id });
  });

  test('la liste des tâches est complète et chaque planification est une expression cron valide', () => {
    const cron = require('node-cron');
    expect(TACHES.map((t) => t.nom).sort()).toEqual(
      ['abonnements', 'cautions', 'echeances', 'etats_des_lieux', 'expiration_paiements', 'nettoyage', 'quittances_manquantes', 'relances'].sort()
    );
    for (const t of TACHES) expect(cron.validate(t.planification)).toBe(true);
  });

  test.each(TACHES.map((t) => [t.nom, t]))('tâche « %s » : exécution directe sans exception, puis via executerJob (résultat non nul)', async (_nom, tache) => {
    await tache.fn(); // une exception ferait échouer le test
    const espion = jest.spyOn(logger, 'error');
    try {
      const resultat = await executerJob(tache.nom, tache.fn);
      expect(resultat).not.toBeNull();
      expect(espion).not.toHaveBeenCalled();
    } finally {
      espion.mockRestore();
    }
  });

  test("expiration des paiements : la demande échue passe « annulee »", async () => {
    const expiration = TACHES.find((t) => t.nom === 'expiration_paiements');
    await expiration.fn();
    expect(await compter('payment_transactions', "status IN ('initiee', 'en_attente') AND mode = 'integre' AND expires_at < now()")).toBe(0);
  });
});

describe('relances (§ 14) : lots ordonnés jusqu’à épuisement, une relance par échéance et par délai', () => {
  /**
   * Insère `n` échéances ouvertes d'un même bail, toutes exigibles le `jour`
   * (délai 0 = J0), périodes distinctes (contrainte d'unicité du bail).
   */
  async function echeancesDuJour(b, n, jour) {
    return q(`
      INSERT INTO rent_schedules (owner_id, lease_id, apartment_id, tenant_id, period_start, period_end, due_date, label,
                                  rent_amount, charges_amount, amount_due, amount_paid, status)
      SELECT :o, :l, :a, :t, DATE '1901-01-01' + g, DATE '1901-01-01' + g, CAST(:jour AS date), 'Loyer', 1000, 0, 1000, 0, 'a_payer'
        FROM generate_series(1, :n) g
      RETURNING id`, {
      o: b.lease.owner_id, l: b.lease.id, a: b.apartment.id, t: b.tenant.id, jour, n,
    });
  }

  const relancesDu = (leaseId, jour) => q(`
    SELECT rr.rent_schedule_id, count(*)::int AS n
      FROM rent_reminders rr JOIN rent_schedules rs ON rs.id = rr.rent_schedule_id
     WHERE rs.lease_id = :l AND rs.due_date = :jour AND rr.offset_days = 0
     GROUP BY rr.rent_schedule_id`, { l: leaseId, jour });

  test('petit lot configurable : toutes les relances partent, exactement une fois chacune', async () => {
    const p = await nouveauProprietaire();
    const b = await bailActif(p);
    const jour = '2033-03-15';
    const lignes = await echeancesDuJour(b, 7, jour);

    const envoyees = await relances.envoyerRelances(jour, { tailleLot: 2 });
    expect(envoyees).toBeGreaterThanOrEqual(7);
    const faites = await relancesDu(b.lease.id, jour);
    expect(faites).toHaveLength(7);
    expect(faites.every((f) => f.n === 1)).toBe(true);
    expect(new Set(faites.map((f) => f.rent_schedule_id))).toEqual(new Set(lignes.map((l) => l.id)));

    // Rejouer le job (redémarrage, double déclenchement) : rien de plus.
    await relances.envoyerRelances(jour, { tailleLot: 2 });
    expect((await relancesDu(b.lease.id, jour)).every((f) => f.n === 1)).toBe(true);
  });

  test('taille de lot lue dans RELANCES_TAILLE_LOT ; deux exécutions CONCURRENTES n’envoient chaque relance qu’une fois', async () => {
    const p = await nouveauProprietaire();
    const b = await bailActif(p);
    const jour = '2033-05-20';
    await echeancesDuJour(b, 9, jour);
    const avant = process.env.RELANCES_TAILLE_LOT;
    process.env.RELANCES_TAILLE_LOT = '3';
    try {
      const [n1, n2] = await Promise.all([relances.envoyerRelances(jour), relances.envoyerRelances(jour)]);
      expect(n1 + n2).toBeGreaterThanOrEqual(9);
    } finally {
      if (avant === undefined) delete process.env.RELANCES_TAILLE_LOT; else process.env.RELANCES_TAILLE_LOT = avant;
    }
    const faites = await relancesDu(b.lease.id, jour);
    expect(faites).toHaveLength(9);
    expect(faites.every((f) => f.n === 1)).toBe(true);
    // Une notification locataire par relance, pas davantage.
    const [{ n }] = await q("SELECT count(*)::int AS n FROM rent_reminders rr JOIN rent_schedules rs ON rs.id = rr.rent_schedule_id WHERE rs.lease_id = :l", { l: b.lease.id });
    expect(n).toBe(9);
  });

  test('régression #11 : plus de 5000 échéances le même jour → TOUTES relancées (lot par défaut)', async () => {
    const p = await nouveauProprietaire();
    const b = await bailActif(p);
    const jour = '2034-01-10';
    await echeancesDuJour(b, 5003, jour);

    await relances.envoyerRelances(jour);
    const faites = await relancesDu(b.lease.id, jour);
    expect(faites).toHaveLength(5003);
    expect(faites.every((f) => f.n === 1)).toBe(true);
  }, 600000);
});
