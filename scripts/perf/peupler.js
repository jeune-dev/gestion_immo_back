'use strict';

/**
 * Base de VOLUME pour l'audit de performance (docs/PERFORMANCE.md).
 *
 *   node scripts/perf/peupler.js [--proprietaires 50] [--baux 7] [--gros 200]
 *
 * Crée `gestion_imo_perf_test` (clone du schéma de la base de test modèle,
 * construite par `npm test`), puis la remplit par les VRAIES routes de l'API,
 * comme le ferait le mobile — règles métier, échéances, allocations,
 * quittances et caisse sont donc exactement celles de la production :
 *
 *   - N propriétaires « courants » (7 baux chacun) + 1 GROS propriétaire
 *     (200 baux sur 10 immeubles) ;
 *   - baux démarrés le 1er octobre 2025 : ~12 mois d'historique payé, et
 *     12 mois d'échéances à venir (horizon) — > 10 000 échéances au total ;
 *   - un locataire activé par propriétaire (comptes du test de charge),
 *     dépenses, travaux, incidents, messages.
 *
 * Les identifiants de connexion (valeurs de TEST) sont écrits dans
 * tmp/perf-comptes.json pour scripts/perf/charge.js et audit-sql.js.
 * Le nom de la base contient « test » : jamais la base de production.
 */
const path = require('path');
const fs = require('fs');

const BASE = 'gestion_imo_perf_test';
const arg = (nom, defaut) => {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 ? Number(process.argv[i + 1]) : defaut;
};
const NB_PROPRIETAIRES = arg('proprietaires', 50);
const BAUX_PAR_PROPRIETAIRE = arg('baux', 7);
const BAUX_GROS = arg('gros', 200);

process.env.DB_NAME = BASE;
process.env.UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'tmp', `uploads-${BASE}`);
require('../../src/__tests__/setup/env.js');

async function creerBase() {
  const { Sequelize } = require('sequelize');
  const modele = process.env.DB_NAME_MODELE === BASE ? 'gestion_imo_test' : (process.env.DB_NAME_MODELE || 'gestion_imo_test');
  const admin = new Sequelize('postgres', process.env.DB_USER, process.env.DB_PASSWORD, {
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), dialect: 'postgres', logging: false,
  });
  await admin.query(`DROP DATABASE IF EXISTS "${BASE}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${BASE}" TEMPLATE "${modele}"`);
  await admin.close();
}

const verifier = (res, attendu, etape) => {
  if (res.status !== attendu) throw new Error(`${etape} : ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.data;
};

async function main() {
  const debut = Date.now();
  await creerBase();
  const h = require('../../src/__tests__/setup/helpers.js');
  const { api, sequelize } = h;
  const droits = require('../../src/modules/abonnement/service/droits.service.js');
  await h.publierModeleBail('habitation');
  const [[categorie]] = await sequelize.query("SELECT id FROM expense_categories WHERE owner_id IS NULL AND code = 'travaux'");

  const comptes = [];
  const total = NB_PROPRIETAIRES + 1;
  for (let n = 0; n < total; n += 1) {
    const gros = n === 0;
    const nbBaux = gros ? BAUX_GROS : BAUX_PAR_PROPRIETAIRE;
    const p = await h.nouveauProprietaire({ first_name: gros ? 'Gros' : 'Proprio', last_name: `N${n}` });
    await sequelize.query(
      "UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = 'PRO'), current_period_end = '2027-12-31' WHERE owner_id = :o",
      { replacements: { o: p.ownerId } }
    );
    await droits.invalider(p.ownerId);
    await h.desactiverEdlObligatoire(p);

    const parImmeuble = 20;
    let immeuble = null;
    const baux = [];
    for (let i = 0; i < nbBaux; i += 1) {
      if (i % parImmeuble === 0) immeuble = await h.creerImmeuble(p);
      const appart = await h.creerAppartement(p, immeuble.id, { rent_amount: 150000 + (i % 10) * 25000 });
      const locataire = await h.creerLocataire(p);
      const bail = verifier(await api().post('/api/v1/baux').set(p.h).send({
        apartment_id: appart.id, tenant_id: locataire.id, start_date: '2025-10-01',
        rent_amount: appart.rent_amount, deposit_amount: appart.rent_amount * 2, due_day: 5,
      }), 201, 'bail').lease;
      verifier(await api().post(`/api/v1/baux/${bail.id}/activer`).set(p.h).send({}), 200, 'activation');
      baux.push({ bail, locataire, immeuble });

      // Historique : tout ce qui est échu est payé (un paiement par bail, alloué
      // aux échéances les plus anciennes), sauf un bail sur cinq resté en retard.
      if (i % 5 !== 4) {
        const echues = (await h.echeancesDu(p, bail.id)).filter((e) => e.due_date <= '2026-10-04');
        const du = echues.reduce((s, e) => s + Number(e.amount_due) - Number(e.amount_paid || 0), 0);
        if (du > 0) await h.payerEspeces(p, bail.id, du, { paidOn: '2026-10-01' });
      }
    }

    // Exploitation courante : dépenses, travaux, messages.
    for (let k = 0; k < (gros ? 40 : 5); k += 1) {
      const { immeuble: imm } = baux[k % baux.length];
      verifier(await api().post('/api/v1/depenses').set(p.h).send({
        amount: 15000 + k * 1000, category_id: categorie.id, method: 'especes', spent_on: '2026-09-15', building_id: imm.id, description: `Entretien ${k}`,
      }), 201, 'dépense');
      if (k % 2 === 0) {
        verifier(await api().post('/api/v1/travaux').set(p.h).send({ title: `Réparation ${k}`, category: 'plomberie', building_id: imm.id }), 201, 'travaux');
      }
    }

    // Un locataire activé (comptes du test de charge), avec incidents et messages.
    const premier = baux[0];
    const loc = await h.activerLocataire(p, premier.locataire);
    for (let k = 0; k < 3; k += 1) {
      verifier(await api().post('/api/v1/locataire/incidents').set(loc.h).send({ category: 'fuite', title: `Fuite ${k}`, description: 'Fuite sous l’évier' }), 201, 'incident');
      verifier(await api().post(`/api/v1/messagerie/locataires/${premier.locataire.id}/messages`).set(p.h).send({ body: `Bonjour ${k}` }), 201, 'message');
    }

    comptes.push({
      gros,
      proprietaire: p.identifiants,
      locataire: { identifiant: premier.locataire.phone, password: h.MOT_DE_PASSE },
      ownerId: p.ownerId,
      leaseIds: baux.slice(0, 5).map((b) => b.bail.id),
    });
    process.stdout.write(`propriétaire ${n + 1}/${total} (${nbBaux} baux) — ${Math.round((Date.now() - debut) / 1000)} s\n`);
  }

  const admin = await h.superAdmin();
  const dossier = path.resolve(__dirname, '..', '..', 'tmp');
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(path.join(dossier, 'perf-comptes.json'), JSON.stringify({
    base: BASE, comptes, admin: { email: admin.email, secret: admin.secret, password: h.MOT_DE_PASSE },
  }, null, 2));

  // Laisse les quittances (générées après validation) se terminer, puis compte.
  const quittances = require('../../src/modules/quittance/service/quittance.service.js');
  if (quittances.produireDocumentsManquants) await quittances.produireDocumentsManquants();
  await sequelize.query('ANALYZE');
  const [[vol]] = await sequelize.query(`SELECT
    (SELECT count(*) FROM owners) AS proprietaires, (SELECT count(*) FROM buildings) AS immeubles,
    (SELECT count(*) FROM apartments) AS appartements, (SELECT count(*) FROM leases) AS baux,
    (SELECT count(*) FROM rent_schedules) AS echeances, (SELECT count(*) FROM rent_payments) AS paiements,
    (SELECT count(*) FROM payment_allocations) AS allocations, (SELECT count(*) FROM receipts) AS quittances,
    (SELECT count(*) FROM cash_movements) AS mouvements_caisse, (SELECT count(*) FROM audit_logs) AS journal_audit,
    (SELECT count(*) FROM notifications) AS notifications`);
  process.stdout.write(`\nVolume : ${JSON.stringify(vol)}\nDurée : ${Math.round((Date.now() - debut) / 1000)} s\n`);
  await h.fermer();
}

main().catch((e) => {
  process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
