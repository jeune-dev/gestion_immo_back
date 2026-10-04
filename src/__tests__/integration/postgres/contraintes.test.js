'use strict';

const {
  proprietaireEtLocataire, echeancesDu, payerEspeces, api, fermer, sequelize,
} = require('../../setup/helpers.js');
const E = require('../../../config/enums.js');

/**
 * Intégrité garantie PAR POSTGRESQL (§ 41, § 42, § 51.3, § 55.4) : même un
 * code applicatif défaillant — ou un accès SQL direct — ne peut pas écrire un
 * état impossible. Chaque test viole volontairement une contrainte et vérifie
 * le CODE d'erreur PostgreSQL exact.
 *
 *   23514 CHECK · 23505 UNIQUE · 23503 FOREIGN KEY · 23502 NOT NULL
 */

// Une seule fermeture du pool, après TOUS les blocs du fichier.
afterAll(fermer);

async function codeErreur(sql, replacements = {}) {
  try {
    await sequelize.transaction(async (t) => sequelize.query(sql, { replacements, transaction: t }));
    return 'aucune erreur';
  } catch (err) {
    return err.parent?.code || err.original?.code || err.message;
  }
}

describe('Contraintes PostgreSQL', () => {
  let ctx;
  beforeAll(async () => {
    const base = await proprietaireEtLocataire();
    const echeances = await echeancesDu(base.proprio, base.lease.id);
    const paiement = await payerEspeces(base.proprio, base.lease.id, echeances[0].amount_due, { scheduleId: echeances[0].id });
    const [[deposit]] = await sequelize.query('SELECT id FROM deposits WHERE lease_id = :l', { replacements: { l: base.lease.id } });
    ctx = { ...base, echeances, paiement, depositId: deposit.id, o: base.proprio.ownerId };
  }, 120000);

  describe('comptes', () => {
    test('un utilisateur sans e-mail ni téléphone est refusé (CHECK)', async () => {
      expect(await codeErreur("INSERT INTO users (role_code, first_name, last_name, password_hash) VALUES ('proprietaire', 'A', 'B', 'x')")).toBe('23514');
    });
    test('e-mail unique sans tenir compte de la casse (UNIQUE partiel)', async () => {
      const [[u]] = await sequelize.query('SELECT email FROM users WHERE id = :id', { replacements: { id: ctx.proprio.user.id } });
      expect(await codeErreur("INSERT INTO users (role_code, first_name, last_name, email, password_hash) VALUES ('proprietaire', 'A', 'B', upper(:e), 'x')", { e: u.email })).toBe('23505');
    });
    test('rôle inexistant refusé (FOREIGN KEY)', async () => {
      expect(await codeErreur("INSERT INTO users (role_code, first_name, last_name, email, password_hash) VALUES ('pirate', 'A', 'B', 'x@y.sn', 'x')")).toBe('23503');
    });
    test('statut hors énumération refusé', async () => {
      expect(await codeErreur("UPDATE users SET status = 'banni' WHERE id = :id", { id: ctx.proprio.user.id })).toBe('23514');
    });
  });

  describe('patrimoine', () => {
    test('loyer négatif refusé', async () => {
      expect(await codeErreur('UPDATE apartments SET rent_amount = -1 WHERE id = :id', { id: ctx.apartment.id })).toBe('23514');
    });
    test('numéro d’appartement unique par immeuble, sans tenir compte de la casse', async () => {
      const [[a]] = await sequelize.query('SELECT number FROM apartments WHERE id = :id', { replacements: { id: ctx.apartment.id } });
      expect(await codeErreur(
        "INSERT INTO apartments (owner_id, building_id, number, type, rent_amount) VALUES (:o, :b, lower(:n), 'f2', 1000)",
        { o: ctx.o, b: ctx.building.id, n: a.number }
      )).toBe('23505');
    });
    test('appartement rattaché à un immeuble inexistant refusé', async () => {
      expect(await codeErreur(
        "INSERT INTO apartments (owner_id, building_id, number, type, rent_amount) VALUES (:o, gen_random_uuid(), 'Z1', 'f2', 1000)",
        { o: ctx.o }
      )).toBe('23503');
    });
    test('§ 41 : deux baux ACTIFS sur le même appartement sont impossibles', async () => {
      expect(await codeErreur(
        `INSERT INTO leases (owner_id, apartment_id, tenant_id, reference, start_date, rent_amount, status)
         VALUES (:o, :a, :t, 'BAIL-DOUBLON', '2026-10-01', 1000, 'actif')`,
        { o: ctx.o, a: ctx.apartment.id, t: ctx.tenant.id }
      )).toBe('23505');
    });
    test('bail : date de fin antérieure au début et jour d’échéance hors 1–28 refusés', async () => {
      expect(await codeErreur("UPDATE leases SET end_date = start_date - 1 WHERE id = :id", { id: ctx.lease.id })).toBe('23514');
      expect(await codeErreur('UPDATE leases SET due_day = 29 WHERE id = :id', { id: ctx.lease.id })).toBe('23514');
    });
  });

  describe('finances', () => {
    test('§ 41 : une échéance ne peut pas être « plus que payée » ni PAYÉE sans être soldée', async () => {
      const e = ctx.echeances[1];
      expect(await codeErreur('UPDATE rent_schedules SET amount_paid = amount_due + 1 WHERE id = :id', { id: e.id })).toBe('23514');
      expect(await codeErreur("UPDATE rent_schedules SET status = 'paye' WHERE id = :id", { id: e.id })).toBe('23514');
      expect(await codeErreur('UPDATE rent_schedules SET amount_due = amount_due + 1 WHERE id = :id', { id: e.id })).toBe('23514');
    });
    test('une allocation vise exactement une échéance OU une charge', async () => {
      expect(await codeErreur(
        'INSERT INTO payment_allocations (owner_id, rent_payment_id, amount) VALUES (:o, :p, 10)',
        { o: ctx.o, p: ctx.paiement.payment.id }
      )).toBe('23514');
    });
    test('§ 51.3 : un identifiant de transaction fournisseur n’est compté qu’une fois', async () => {
      const inserer = () => codeErreur(
        `INSERT INTO payment_transactions (owner_id, tenant_id, lease_id, provider, mode, reference, provider_transaction_id, amount, initiated_by)
         VALUES (:o, :t, :l, 'wave', 'preuve', 'TRX-' || gen_random_uuid(), 'WV-UNIQUE-42', 1000, :u)`,
        { o: ctx.o, t: ctx.tenant.id, l: ctx.lease.id, u: ctx.proprio.user.id }
      );
      expect(await inserer()).toBe('aucune erreur');
      expect(await inserer()).toBe('23505');
    });
    test('une seule quittance VALIDE par échéance', async () => {
      expect(await codeErreur(
        `INSERT INTO receipts (owner_id, rent_schedule_id, lease_id, tenant_id, number, amount)
         VALUES (:o, :s, :l, :t, 'QUI-DOUBLON', 1)`,
        { o: ctx.o, s: ctx.echeances[0].id, l: ctx.lease.id, t: ctx.tenant.id }
      )).toBe('23505');
    });
    test('mouvement de caisse : la caution est toujours marquée à part (hors revenus)', async () => {
      expect(await codeErreur(
        `INSERT INTO cash_movements (owner_id, direction, category, amount, method, occurred_on, label, source_type, is_deposit)
         VALUES (:o, 'entree', 'caution', 10, 'especes', '2026-09-01', 'x', 'manuel', false)`,
        { o: ctx.o }
      )).toBe('23514');
      expect(await codeErreur(
        `INSERT INTO cash_movements (owner_id, direction, category, amount, method, occurred_on, label, source_type, is_deposit)
         VALUES (:o, 'entree', 'loyer', 0, 'especes', '2026-09-01', 'x', 'manuel', false)`,
        { o: ctx.o }
      )).toBe('23514');
    });
    test('§ 55.4 : retenue sur caution impossible sans motif, description et justificatif', async () => {
      expect(await codeErreur(
        `INSERT INTO deposit_transactions (owner_id, deposit_id, type, amount, occurred_on, reason, description)
         VALUES (:o, :d, 'retenue', 1000, '2026-09-01', 'degradation', 'Porte')`,
        { o: ctx.o, d: ctx.depositId }
      )).toBe('23514');
    });
    test('§ 55 : retenu + restitué ne dépasse jamais le versé', async () => {
      expect(await codeErreur('UPDATE deposits SET amount_withheld = amount_received + 1 WHERE id = :id', { id: ctx.depositId })).toBe('23514');
    });
    test('facture commune : méthode de répartition obligatoire (§ 41) et montant positif', async () => {
      expect(await codeErreur(
        `INSERT INTO charge_invoices (owner_id, building_id, charge_type, period_start, period_end, amount)
         VALUES (:o, :b, 'eau', '2026-09-01', '2026-09-30', 1000)`,
        { o: ctx.o, b: ctx.building.id }
      )).toBe('23502');
      expect(await codeErreur(
        `INSERT INTO charge_invoices (owner_id, building_id, charge_type, period_start, period_end, amount, allocation_method)
         VALUES (:o, :b, 'eau', '2026-09-01', '2026-09-30', 0, 'egale')`,
        { o: ctx.o, b: ctx.building.id }
      )).toBe('23514');
    });
    test('dépense liée à un immeuble obligatoire (§ 41)', async () => {
      const [[c]] = await sequelize.query("SELECT id FROM expense_categories WHERE owner_id IS NULL LIMIT 1");
      expect(await codeErreur(
        `INSERT INTO expenses (owner_id, category_id, amount, method, spent_on, created_by)
         VALUES (:o, :c, 1000, 'especes', '2026-09-01', :u)`,
        { o: ctx.o, c: c.id, u: ctx.proprio.user.id }
      )).toBe('23502');
    });
  });

  describe('opérations et plateforme', () => {
    test('travaux « artisan assigné » sans artisan refusés', async () => {
      expect(await codeErreur(
        `INSERT INTO work_orders (owner_id, number, building_id, title, category, status)
         VALUES (:o, 99999, :b, 'x', 'autre', 'artisan_assigne')`,
        { o: ctx.o, b: ctx.building.id }
      )).toBe('23514');
    });
    test('message sans texte ni pièce jointe refusé', async () => {
      const [[fil]] = await sequelize.query(
        'INSERT INTO message_threads (owner_id, tenant_id) VALUES (:o, :t) ON CONFLICT (owner_id, tenant_id) DO UPDATE SET updated_at = now() RETURNING id',
        { replacements: { o: ctx.o, t: ctx.tenant.id } }
      );
      expect(await codeErreur(
        "INSERT INTO messages (thread_id, sender_user_id, sender_role) VALUES (:f, :u, 'proprietaire')",
        { f: fil.id, u: ctx.proprio.user.id }
      )).toBe('23514');
    });
    test('un seul abonnement courant par propriétaire', async () => {
      expect(await codeErreur(
        `INSERT INTO subscriptions (owner_id, plan_id, status, current_period_start, current_period_end)
         SELECT :o, id, 'actif', '2026-09-01', '2026-10-01' FROM subscription_plans WHERE code = 'PRO'`,
        { o: ctx.o }
      )).toBe('23505');
    });
    test('une seule version PUBLIÉE par type de modèle de bail', async () => {
      // Indépendant de l'ordre : une version « meublé » est publiée AU PLUS une
      // fois (un autre test peut l'avoir fait) ; sinon la v1 l'est le temps du test.
      const [[deja]] = await sequelize.query("SELECT id FROM lease_templates WHERE lease_type = 'meuble' AND status = 'publie' LIMIT 1");
      if (!deja) await sequelize.query("UPDATE lease_templates SET status = 'publie' WHERE lease_type = 'meuble' AND version = 1");
      try {
        expect(await codeErreur(
          `INSERT INTO lease_templates (lease_type, version, title, body, status) VALUES ('meuble', 99, 't', 'b', 'publie')`
        )).toBe('23505');
      } finally {
        if (!deja) await sequelize.query("UPDATE lease_templates SET status = 'brouillon' WHERE lease_type = 'meuble' AND version = 1");
      }
    });
    test('document rattaché à un type de ressource inconnu refusé', async () => {
      expect(await codeErreur(
        `INSERT INTO documents (owner_id, entity_type, entity_id, category, storage_key, mime_type, size_bytes)
         VALUES (:o, 'pirate', gen_random_uuid(), 'photo', 'k', 'image/png', 1)`,
        { o: ctx.o }
      )).toBe('23514');
    });
    test('idempotence : une clé par utilisateur', async () => {
      const inserer = () => codeErreur(
        `INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, expires_at)
         VALUES (:u, 'cle-unique-test', 'POST', '/x', repeat('a', 64), now() + interval '1 day')`,
        { u: ctx.proprio.user.id }
      );
      expect(await inserer()).toBe('aucune erreur');
      expect(await inserer()).toBe('23505');
    });
  });

  test('suppression d’un propriétaire interdite tant que ses données existent (pas de cascade financière)', async () => {
    expect(await codeErreur('DELETE FROM owners WHERE id = :o', { o: ctx.o })).toBe('23503');
    expect(await codeErreur('DELETE FROM leases WHERE id = :l', { l: ctx.lease.id })).toBe('23503');
  });

  test('§ 42 suppression logique : un immeuble supprimé disparaît de l’API mais reste en base', async () => {
    const res = await api().post('/api/v1/immeubles').set(ctx.proprio.h).send({ name: 'Éphémère', address: 'x', city: 'Dakar' });
    const id = res.body.data.building.id;
    expect((await api().delete(`/api/v1/immeubles/${id}`).set(ctx.proprio.h)).status).toBe(200);
    expect((await api().get(`/api/v1/immeubles/${id}`).set(ctx.proprio.h)).status).toBe(404);
    const [[ligne]] = await sequelize.query('SELECT deleted_at FROM buildings WHERE id = :id', { replacements: { id } });
    expect(ligne.deleted_at).not.toBeNull();
    // Le nom redevient disponible (index unique partiel sur les lignes vivantes).
    expect((await api().post('/api/v1/immeubles').set(ctx.proprio.h).send({ name: 'Éphémère', address: 'x', city: 'Dakar' })).status).toBe(201);
  });
});

describe('Cohérence énumérations du code ↔ contraintes CHECK de la base', () => {
  /** Valeurs autorisées par le CHECK `IN (...)` d'une colonne. */
  async function valeursCheck(table, colonne) {
    const [lignes] = await sequelize.query(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        WHERE c.contype = 'c' AND c.conrelid = CAST(:table AS regclass)`,
      { replacements: { table } }
    );
    const def = lignes.map((l) => l.def).find((d) => new RegExp(`\\(\\(?${colonne}\\)?::text = ANY`).test(d));
    if (!def) return null;
    return [...def.matchAll(/'([^']+)'::(character varying|text)/g)].map((m) => m[1]).sort();
  }

  test.each([
    ['users', 'status', E.STATUT_UTILISATEUR], ['owners', 'status', E.STATUT_PROPRIETAIRE],
    ['apartments', 'status', E.STATUT_APPARTEMENT], ['apartments', 'type', E.TYPE_APPARTEMENT],
    ['tenants', 'id_document_type', E.TYPE_PIECE_IDENTITE], ['leases', 'lease_type', E.TYPE_BAIL],
    ['leases', 'periodicity', E.PERIODICITE], ['leases', 'status', E.STATUT_BAIL],
    ['rent_schedules', 'status', E.STATUT_ECHEANCE], ['charge_invoices', 'charge_type', E.TYPE_CHARGE],
    ['charge_invoices', 'allocation_method', E.METHODE_REPARTITION], ['charge_invoices', 'status', E.STATUT_FACTURE_COMMUNE],
    ['charges', 'status', E.STATUT_CHARGE], ['rent_payments', 'method', E.MODE_PAIEMENT],
    ['payment_transactions', 'provider', E.FOURNISSEUR_PAIEMENT], ['payment_transactions', 'status', E.STATUT_TRANSACTION],
    ['payment_transactions', 'mode', E.MODE_TRANSACTION], ['payment_transactions', 'wallet', E.PORTEFEUILLE],
    ['rent_payments', 'status', E.STATUT_PAIEMENT], ['reconciliation_entries', 'type', E.TYPE_RAPPROCHEMENT],
    ['reconciliation_entries', 'status', E.STATUT_RAPPROCHEMENT], ['expense_categories', 'cash_group', E.GROUPE_CAISSE_SORTIE],
    ['cash_movements', 'category', E.CATEGORIE_CAISSE], ['cash_movements', 'direction', E.SENS_CAISSE],
    ['expenses', 'status', E.STATUT_DEPENSE], ['contractors', 'trade', E.METIER_ARTISAN],
    ['work_orders', 'category', E.CATEGORIE_TRAVAUX], ['work_orders', 'priority', E.PRIORITE],
    ['work_orders', 'status', E.STATUT_TRAVAUX], ['work_photos', 'phase', E.PHASE_PHOTO],
    ['incidents', 'category', E.CATEGORIE_INCIDENT], ['incidents', 'status', E.STATUT_INCIDENT],
    ['inspections', 'type', E.TYPE_ETAT_DES_LIEUX], ['inspections', 'status', E.STATUT_ETAT_DES_LIEUX],
    ['inspection_items', 'element', E.ELEMENT_ETAT_DES_LIEUX], ['inspection_items', 'condition', E.ETAT_ELEMENT],
    ['deposits', 'status', E.STATUT_CAUTION], ['deposit_transactions', 'type', E.TYPE_MOUVEMENT_CAUTION],
    ['deposit_transactions', 'reason', E.MOTIF_RETENUE], ['deposit_transactions', 'contest_status', E.STATUT_CONTESTATION],
    ['message_deliveries', 'channel', E.CANAL], ['message_deliveries', 'status', E.STATUT_ENVOI],
    ['notifications', 'type', E.TYPE_NOTIFICATION], ['subscriptions', 'status', E.STATUT_ABONNEMENT],
    ['subscription_plans', 'billing_period', E.PERIODE_FACTURATION], ['subscription_plans', 'status', E.STATUT_PLAN],
    ['subscription_payments', 'status', E.STATUT_PAIEMENT_ABONNEMENT], ['lease_templates', 'status', E.STATUT_MODELE_BAIL],
    ['documents', 'category', E.CATEGORIE_DOCUMENT], ['documents', 'entity_type', E.ENTITE_DOCUMENT],
    ['device_tokens', 'platform', E.PLATEFORME_APPAREIL],
  ])('%s.%s accepte exactement les valeurs de config/enums.js', async (table, colonne, enumeration) => {
    expect(await valeursCheck(table, colonne)).toEqual(E.codes(enumeration).sort());
  });
});
