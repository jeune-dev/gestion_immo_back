'use strict';

const fs = require('fs');
const path = require('path');
const {
  api, nouveauProprietaire, superAdmin, creerImmeuble, creerAppartement, creerLocataire, desactiverEdlObligatoire,
  bailActif, activerLocataire, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');
const { LeaseDocument } = require('../../../../models/index.js');
const storage = require('../../../../infrastructure/storage.service.js');
const { aujourdhui, ajouterJours } = require('../../../../utils/dates.js');
const {
  UUID_INCONNU, jetonsDegrades, verifierMatrice, verifierStatuts, proprietaireSansPermission,
} = require('./securite.outils.js');

/**
 * Baux (§ 10) et contrats générés (§ 53) — toutes les routes /baux :
 * nominal, authentification, autorisation, validation, pagination, filtres,
 * cycle de vie complet (chaque transition interdite → 409), génération de
 * contrat versionnée, transactions sans reste (ni ligne ni fichier) et
 * concurrence.
 *
 * Les contrats utilisent le modèle « professionnel » : son état de
 * publication est restauré à la fin (la base du worker est partagée par les
 * fichiers de test qui s'y succèdent).
 */

const BASE = '/api/v1/baux';

/** Fichiers présents sous le dossier de stockage d'un espace (preuve d'absence d'orphelin). */
function fichiersDe(ownerId) {
  const dossier = path.join(storage.UPLOAD_DIR, 'owners', ownerId);
  if (!fs.existsSync(dossier)) return [];
  return fs.readdirSync(dossier, { recursive: true }).filter((f) => fs.statSync(path.join(dossier, f)).isFile());
}

async function brouillon(proprio, surcharges = {}, appartement = {}) {
  const building = await creerImmeuble(proprio);
  const apartment = await creerAppartement(proprio, building.id, appartement);
  const tenant = await creerLocataire(proprio);
  const res = await api().post(BASE).set(proprio.h).send({
    apartment_id: apartment.id, tenant_id: tenant.id, start_date: '2026-09-01', deposit_amount: 0, due_day: 5, ...surcharges,
  });
  if (res.status !== 201) throw new Error(`Bail : ${res.status} ${JSON.stringify(res.body)}`);
  return { lease: res.body.data.lease, building, apartment, tenant };
}

async function publierProfessionnel() {
  await sequelize.query("UPDATE lease_templates SET status = 'brouillon' WHERE lease_type = 'professionnel' AND status = 'publie'");
  await sequelize.query("UPDATE lease_templates SET status = 'publie', published_at = now() WHERE lease_type = 'professionnel' AND version = 1");
}

/** Propriétaire neuf (EDL d'entrée désactivé) : chaque test a son espace, et la limite d'immeubles de la formule d'essai n'est jamais atteinte. */
async function proprietaire() {
  const p = await nouveauProprietaire();
  await desactiverEdlObligatoire(p);
  return p;
}

describe('Baux (§ 10) et contrats (§ 53)', () => {
  let A; let B; let admin;

  beforeAll(async () => {
    [A, B, admin] = await Promise.all([nouveauProprietaire(), nouveauProprietaire(), superAdmin()]);
    await Promise.all([desactiverEdlObligatoire(A), desactiverEdlObligatoire(B)]);
  });

  afterAll(async () => {
    // Modèles « professionnel » remis dans leur état d'origine (v1 brouillon, versions de test archivées).
    await sequelize.query("UPDATE lease_templates SET status = 'archive' WHERE lease_type = 'professionnel' AND version > 1");
    await sequelize.query("UPDATE lease_templates SET status = 'brouillon', published_at = NULL WHERE lease_type = 'professionnel' AND version = 1");
    await fermer();
  });

  describe('création et lecture', () => {
    test('POST /baux : brouillon créé, référence lisible, valeurs par défaut de l’appartement, audit', async () => {
      const building = await creerImmeuble(A);
      const apartment = await creerAppartement(A, building.id, { rent_amount: 250000, charges_amount: 15000, is_furnished: true });
      const tenant = await creerLocataire(A);
      const res = await api().post(BASE).set(A.h).send({
        apartment_id: apartment.id, tenant_id: tenant.id, start_date: '2026-10-01', end_date: '2027-09-30', deposit_amount: 500000,
        special_conditions: 'Pas d’animaux', owner_id: B.ownerId, status: 'actif', reference: 'PIRATE',
      });
      expect(res.status).toBe(201);
      const { lease } = res.body.data;
      expect(lease).toMatchObject({
        status: 'brouillon', owner_id: A.ownerId, apartment_id: apartment.id, tenant_id: tenant.id, rent_amount: 250000,
        charges_amount: 15000, lease_type: 'meuble', deposit_amount: 500000, special_conditions: 'Pas d’animaux',
      });
      expect(lease.reference).toMatch(/^BAIL-\d{4}-\d{4}$/);
      expect(await compter('audit_logs', "action = 'bail.creation' AND entity_id = :id", { id: lease.id })).toBe(1);
      // Rien n'est généré tant que le bail est un brouillon.
      expect(await compter('rent_schedules', 'lease_id = :id', { id: lease.id })).toBe(0);
      expect(await compter('deposits', 'lease_id = :id', { id: lease.id })).toBe(0);
    });

    test('POST /baux : validation (422) et références d’autrui (403) ou absentes (422)', async () => {
      const { apartment, tenant } = await brouillon(A);
      const autre = await brouillon(B);
      const valide = { apartment_id: apartment.id, tenant_id: tenant.id, start_date: '2026-10-01' };
      const ecarts = await verifierStatuts([
        ['post', BASE, {}, 422],
        ['post', BASE, { ...valide, apartment_id: undefined }, 422],
        ['post', BASE, { ...valide, tenant_id: 'pas-un-uuid' }, 422],
        ['post', BASE, { ...valide, start_date: '01/10/2026' }, 422],
        ['post', BASE, { ...valide, start_date: '2026-02-30x' }, 422],
        ['post', BASE, { ...valide, end_date: '2026-09-30' }, 422],
        ['post', BASE, { ...valide, end_date: '2026-10-01' }, 422],
        ['post', BASE, { ...valide, rent_amount: 0 }, 422],
        ['post', BASE, { ...valide, rent_amount: -1 }, 422],
        ['post', BASE, { ...valide, rent_amount: 12.5 }, 422],
        ['post', BASE, { ...valide, rent_amount: 'beaucoup' }, 422],
        ['post', BASE, { ...valide, deposit_amount: -500 }, 422],
        ['post', BASE, { ...valide, due_day: 0 }, 422],
        ['post', BASE, { ...valide, due_day: 29 }, 422],
        ['post', BASE, { ...valide, periodicity: 'hebdomadaire' }, 422],
        ['post', BASE, { ...valide, lease_type: 'saisonnier' }, 422],
        ['post', BASE, { ...valide, occupants_count: 0 }, 422],
        ['post', BASE, { ...valide, notice_period_months: 25 }, 422],
        ['post', BASE, { ...valide, special_conditions: 'x'.repeat(10001) }, 422],
        ['post', BASE, { ...valide, apartment_id: UUID_INCONNU }, 422],
        ['post', BASE, { ...valide, tenant_id: UUID_INCONNU }, 422],
        ['post', BASE, { ...valide, apartment_id: autre.apartment.id }, 403],
        ['post', BASE, { ...valide, tenant_id: autre.tenant.id }, 403],
      ], A.h);
      expect(ecarts).toEqual([]);
    });

    test('GET /baux/:id : détail complet (contrats, états des lieux, soldes, documents) ; 404 / 403 / 422', async () => {
      const { lease } = await bailActif(A);
      const res = await api().get(`${BASE}/${lease.id}`).set(A.h);
      expect(res.status).toBe(200);
      const d = res.body.data.lease;
      expect(d).toMatchObject({ id: lease.id, status: 'actif', contracts: [], inspections: [], documents: [] });
      expect(d.apartment).toHaveProperty('building');
      expect(d.tenant).toHaveProperty('first_name');
      expect(d.deposit).toMatchObject({ amount_expected: 700000, status: 'attendue' });
      expect(Number(d.balance.total_encaisse)).toBe(0);
      expect((await api().get(`${BASE}/${UUID_INCONNU}`).set(A.h)).status).toBe(404);
      expect((await api().get(`${BASE}/${lease.id}`).set(B.h)).status).toBe(403);
      expect((await api().get(`${BASE}/pas-un-uuid`).set(A.h)).status).toBe(422);
    });
  });

  describe('liste, pagination, filtres, tri', () => {
    let P; let baux;

    beforeAll(async () => {
      P = await nouveauProprietaire();
      await desactiverEdlObligatoire(P);
      const b1 = await brouillon(P, { start_date: '2026-01-01', rent_amount: 100000 });
      const b2 = await brouillon(P, { start_date: '2026-02-01', rent_amount: 300000 });
      const b3 = await brouillon(P, { start_date: '2026-03-01', rent_amount: 200000 });
      await api().post(`${BASE}/${b2.lease.id}/activer`).set(P.h).send({});
      baux = [b1, b2, b3];
    });

    test('liste vide pour un nouvel espace ; jamais les baux d’un autre propriétaire', async () => {
      const vide = await nouveauProprietaire();
      const res = await api().get(BASE).set(vide.h);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ items: [], pagination: expect.objectContaining({ total: 0, page: 1 }) });
      const liste = await api().get(`${BASE}?limit=100`).set(P.h);
      expect(liste.body.data.items.every((l) => l.owner_id === P.ownerId)).toBe(true);
    });

    test('pagination : pages 1, 2, au-delà ; total exact ; limite plafonnée à 100', async () => {
      const p1 = await api().get(`${BASE}?limit=2&page=1`).set(P.h);
      expect(p1.body.data.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(p1.body.data.items).toHaveLength(2);
      const p2 = await api().get(`${BASE}?limit=2&page=2`).set(P.h);
      expect(p2.body.data.items).toHaveLength(1);
      const ids = [...p1.body.data.items, ...p2.body.data.items].map((l) => l.id);
      expect(new Set(ids).size).toBe(3);
      const loin = await api().get(`${BASE}?limit=2&page=9`).set(P.h);
      expect(loin.status).toBe(200);
      expect(loin.body.data.items).toEqual([]);
      expect(loin.body.data.pagination.total).toBe(3);
      const plafond = await api().get(`${BASE}?limit=1000`).set(P.h);
      expect(plafond.status).toBe(200);
      expect(plafond.body.data.pagination.limit).toBe(100);
    });

    test('pagination invalide → 422 (page 0, -1, limit 0, non numérique)', async () => {
      const ecarts = await verifierStatuts([
        ['get', `${BASE}?page=0`, undefined, 422],
        ['get', `${BASE}?page=-1`, undefined, 422],
        ['get', `${BASE}?limit=0`, undefined, 422],
        ['get', `${BASE}?limit=abc`, undefined, 422],
        ['get', `${BASE}?page=1.5`, undefined, 422],
      ], P.h);
      expect(ecarts).toEqual([]);
    });

    test('filtres statut, locataire, appartement, immeuble ; tri ; valeurs invalides → 422', async () => {
      const [b1, b2, b3] = baux;
      const statut = await api().get(`${BASE}?status=actif`).set(P.h);
      expect(statut.body.data.items.map((l) => l.id)).toEqual([b2.lease.id]);
      expect((await api().get(`${BASE}?tenant_id=${b1.tenant.id}`).set(P.h)).body.data.items.map((l) => l.id)).toEqual([b1.lease.id]);
      expect((await api().get(`${BASE}?apartment_id=${b3.apartment.id}`).set(P.h)).body.data.items.map((l) => l.id)).toEqual([b3.lease.id]);
      const immeuble = await api().get(`${BASE}?building_id=${b3.building.id}`).set(P.h);
      expect(immeuble.body.data.items.map((l) => l.id)).toEqual([b3.lease.id]);
      expect(immeuble.body.data.pagination.total).toBe(1);

      const parLoyer = await api().get(`${BASE}?tri=rent_amount`).set(P.h);
      expect(parLoyer.body.data.items.map((l) => l.rent_amount)).toEqual([100000, 200000, 300000]);
      const parDebut = await api().get(`${BASE}?tri=-start_date`).set(P.h);
      expect(parDebut.body.data.items.map((l) => l.start_date)).toEqual(['2026-03-01', '2026-02-01', '2026-01-01']);

      const ecarts = await verifierStatuts([
        ['get', `${BASE}?status=inconnu`, undefined, 422],
        ['get', `${BASE}?tri=owner_id`, undefined, 422],
        ['get', `${BASE}?tri=${encodeURIComponent('rent_amount; DROP TABLE leases')}`, undefined, 422],
        ['get', `${BASE}?tenant_id=${encodeURIComponent("' OR 1=1 --")}`, undefined, 422],
        ['get', `${BASE}?building_id=abc`, undefined, 422],
      ], P.h);
      expect(ecarts).toEqual([]);
    });
  });

  describe('cycle de vie brouillon → actif → termine → clos', () => {
    test('activation : échéances, caution « attendue », appartement occupé, audit', async () => {
      const A = await proprietaire();
      const { lease, apartment } = await brouillon(A, { deposit_amount: 400000 });
      const res = await api().post(`${BASE}/${lease.id}/activer`).set(A.h).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.lease.status).toBe('actif');
      expect(res.body.data.avertissements).toEqual([]);
      expect(await compter('rent_schedules', 'lease_id = :id', { id: lease.id })).toBeGreaterThan(0);
      const [[depot]] = await sequelize.query('SELECT amount_expected, status, tenant_id FROM deposits WHERE lease_id = :id', { replacements: { id: lease.id } });
      expect(depot).toMatchObject({ amount_expected: 400000, status: 'attendue', tenant_id: lease.tenant_id });
      const [[appart]] = await sequelize.query('SELECT status FROM apartments WHERE id = :id', { replacements: { id: apartment.id } });
      expect(appart.status).toBe('occupe');
      expect(await compter('audit_logs', "action = 'bail.changement_statut' AND entity_id = :id AND details->>'apres' = 'actif'", { id: lease.id })).toBe(1);
    });

    test('politique « avertissement » : activation avec avertissement ETAT_DES_LIEUX_ENTREE_ABSENT', async () => {
      const p = await nouveauProprietaire();
      await api().patch('/api/v1/parametres').set(p.h).send({ entry_inspection_policy: 'avertissement' });
      const { lease } = await brouillon(p);
      const res = await api().post(`${BASE}/${lease.id}/activer`).set(p.h).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.avertissements.map((a) => a.code)).toEqual(['ETAT_DES_LIEUX_ENTREE_ABSENT']);
    });

    test('toutes les transitions interdites répondent 409 sans rien modifier', async () => {
      const A = await proprietaire();
      const brouillonBail = (await brouillon(A)).lease;
      const actif = (await bailActif(A)).lease;
      const termine = (await bailActif(A)).lease;
      await api().post(`${BASE}/${termine.id}/terminer`).set(A.h).send({ ended_on: '2026-12-31' });
      const clos = (await bailActif(A, { bail: { deposit_amount: 0 } })).lease;
      await api().post(`${BASE}/${clos.id}/terminer`).set(A.h).send({ ended_on: '2026-12-31' });
      expect((await api().post(`${BASE}/${clos.id}/cloturer`).set(A.h).send({})).status).toBe(200);
      const annule = (await brouillon(A)).lease;
      await api().post(`${BASE}/${annule.id}/annuler`).set(A.h).send({ reason: 'Erreur de saisie' });

      const fin = { ended_on: '2026-12-31' };
      const loyer = { rent_amount: 1000, effective_from: ajouterJours(aujourdhui(), 30) };
      const ecarts = await verifierStatuts([
        ['post', `${BASE}/${brouillonBail.id}/terminer`, fin, 409],
        ['post', `${BASE}/${brouillonBail.id}/cloturer`, {}, 409],
        ['post', `${BASE}/${brouillonBail.id}/loyer`, loyer, 409],
        ['post', `${BASE}/${actif.id}/activer`, {}, 409],
        ['post', `${BASE}/${actif.id}/annuler`, { reason: 'Changement' }, 409],
        ['post', `${BASE}/${actif.id}/cloturer`, {}, 409],
        ['patch', `${BASE}/${actif.id}`, { due_day: 10 }, 409],
        ['post', `${BASE}/${termine.id}/activer`, {}, 409],
        ['post', `${BASE}/${termine.id}/terminer`, fin, 409],
        ['post', `${BASE}/${termine.id}/annuler`, { reason: 'Changement' }, 409],
        ['post', `${BASE}/${termine.id}/loyer`, loyer, 409],
        ['patch', `${BASE}/${termine.id}`, { due_day: 10 }, 409],
        ['post', `${BASE}/${clos.id}/activer`, {}, 409],
        ['post', `${BASE}/${clos.id}/terminer`, fin, 409],
        ['post', `${BASE}/${clos.id}/cloturer`, {}, 409],
        ['post', `${BASE}/${clos.id}/annuler`, { reason: 'Changement' }, 409],
        ['post', `${BASE}/${clos.id}/contrats`, {}, 409],
        ['patch', `${BASE}/${clos.id}`, { due_day: 10 }, 409],
        ['post', `${BASE}/${annule.id}/activer`, {}, 409],
        ['post', `${BASE}/${annule.id}/terminer`, fin, 409],
        ['post', `${BASE}/${annule.id}/cloturer`, {}, 409],
        ['post', `${BASE}/${annule.id}/annuler`, { reason: 'Encore' }, 409],
        ['post', `${BASE}/${annule.id}/contrats`, {}, 409],
      ], A.h);
      expect(ecarts).toEqual([]);
      const [statuts] = await sequelize.query('SELECT id, status FROM leases WHERE id IN (:ids)', { replacements: { ids: [brouillonBail.id, actif.id, termine.id, clos.id, annule.id] } });
      const parId = Object.fromEntries(statuts.map((s) => [s.id, s.status]));
      expect(parId).toEqual({
        [brouillonBail.id]: 'brouillon', [actif.id]: 'actif', [termine.id]: 'termine', [clos.id]: 'clos', [annule.id]: 'annule',
      });
    });

    test('PATCH d’un brouillon : champs modifiés, audit, validation, champs interdits ignorés', async () => {
      const A = await proprietaire();
      const { lease } = await brouillon(A);
      const res = await api().patch(`${BASE}/${lease.id}`).set(A.h).send({ due_day: 10, rent_amount: 410000, status: 'actif', owner_id: B.ownerId });
      expect(res.status).toBe(200);
      expect(res.body.data.lease).toMatchObject({ due_day: 10, rent_amount: 410000, status: 'brouillon', owner_id: A.ownerId });
      expect(await compter('audit_logs', "action = 'bail.modification' AND entity_id = :id", { id: lease.id })).toBe(1);
      const ecarts = await verifierStatuts([
        ['patch', `${BASE}/${lease.id}`, {}, 422],
        ['patch', `${BASE}/${lease.id}`, { end_date: '2026-08-01' }, 422],
        ['patch', `${BASE}/${lease.id}`, { rent_amount: 0 }, 422],
        ['patch', `${BASE}/${UUID_INCONNU}`, { due_day: 3 }, 404],
      ], A.h);
      expect(ecarts).toEqual([]);
    });

    test('annulation d’un brouillon : motif obligatoire, audit', async () => {
      const A = await proprietaire();
      const { lease } = await brouillon(A);
      expect((await api().post(`${BASE}/${lease.id}/annuler`).set(A.h).send({})).status).toBe(422);
      expect((await api().post(`${BASE}/${lease.id}/annuler`).set(A.h).send({ reason: 'x' })).status).toBe(422);
      const res = await api().post(`${BASE}/${lease.id}/annuler`).set(A.h).send({ reason: 'Le locataire a renoncé' });
      expect(res.status).toBe(200);
      expect(res.body.data.lease).toMatchObject({ status: 'annule', termination_reason: 'Le locataire a renoncé' });
      expect(await compter('audit_logs', "action = 'bail.changement_statut' AND entity_id = :id AND details->>'apres' = 'annule'", { id: lease.id })).toBe(1);
    });

    test('fin de bail : validation, échéances postérieures annulées, appartement libéré, décompte de caution lancé', async () => {
      const A = await proprietaire();
      const { lease, apartment } = await bailActif(A);
      const [[depot]] = await sequelize.query('SELECT id FROM deposits WHERE lease_id = :id', { replacements: { id: lease.id } });
      await api().post(`/api/v1/cautions/${depot.id}/versements`).set(A.h).send({ amount: 700000, occurred_on: '2026-09-01', method: 'especes' });
      const ecarts = await verifierStatuts([
        ['post', `${BASE}/${lease.id}/terminer`, {}, 422],
        ['post', `${BASE}/${lease.id}/terminer`, { ended_on: 'demain' }, 422],
        ['post', `${BASE}/${lease.id}/terminer`, { ended_on: '2026-08-31' }, 422],
      ], A.h);
      expect(ecarts).toEqual([]);
      const res = await api().post(`${BASE}/${lease.id}/terminer`).set(A.h).send({ ended_on: '2026-11-30', termination_reason: 'Départ' });
      expect(res.status).toBe(200);
      expect(res.body.data.lease).toMatchObject({ status: 'termine', ended_on: '2026-11-30' });
      expect(await compter('rent_schedules', "lease_id = :id AND period_start > '2026-11-30' AND status <> 'annule'", { id: lease.id })).toBe(0);
      const [[appart]] = await sequelize.query('SELECT status FROM apartments WHERE id = :id', { replacements: { id: apartment.id } });
      expect(appart.status).toBe('disponible');
      const [[d]] = await sequelize.query('SELECT status, refund_due_date FROM deposits WHERE id = :id', { replacements: { id: depot.id } });
      expect(d.status).toBe('restitution_en_cours');
      expect(d.refund_due_date).toBeTruthy();
      expect(await compter('notifications', "user_id = :u AND type = 'caution' AND title = 'Décompte de caution à préparer'", { u: A.user.id })).toBeGreaterThanOrEqual(1);
    });

    test('modification du loyer : validation (date passée, rien à modifier, montants), audit', async () => {
      const A = await proprietaire();
      const { lease } = await bailActif(A);
      const ecarts = await verifierStatuts([
        ['post', `${BASE}/${lease.id}/loyer`, { effective_from: '2027-01-01' }, 422],
        ['post', `${BASE}/${lease.id}/loyer`, { rent_amount: 1000 }, 422],
        ['post', `${BASE}/${lease.id}/loyer`, { rent_amount: -5, effective_from: '2027-01-01' }, 422],
        ['post', `${BASE}/${lease.id}/loyer`, { rent_amount: 0, effective_from: '2027-01-01' }, 422],
        ['post', `${BASE}/${lease.id}/loyer`, { rent_amount: 1000, effective_from: '2020-01-01' }, 422],
      ], A.h);
      expect(ecarts).toEqual([]);
      const res = await api().post(`${BASE}/${lease.id}/loyer`).set(A.h).send({ charges_amount: 20000, effective_from: '2027-02-01' });
      expect(res.status).toBe(200);
      expect(res.body.data.lease.charges_amount).toBe(20000);
      expect(res.body.data.echeances_recalculees).toBeGreaterThan(0);
      const [[fev]] = await sequelize.query("SELECT amount_due FROM rent_schedules WHERE lease_id = :l AND period_start = '2027-02-01'", { replacements: { l: lease.id } });
      expect(fev.amount_due).toBe(370000);
    });
  });

  describe('§ 53 contrat généré depuis le modèle', () => {
    test('modèle non publié → 409 MODELE_NON_PUBLIE, AUCUNE ligne ni fichier créés', async () => {
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p, { bail: { lease_type: 'professionnel' } });
      await sequelize.query("UPDATE lease_templates SET status = 'brouillon' WHERE lease_type = 'professionnel' AND status = 'publie'");
      const avant = fichiersDe(p.ownerId).length;
      const res = await api().post(`${BASE}/${lease.id}/contrats`).set(p.h).send({ special_clauses: 'Clause' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MODELE_NON_PUBLIE');
      expect(await compter('lease_documents', 'lease_id = :id', { id: lease.id })).toBe(0);
      expect(await compter('documents', "entity_type = 'lease' AND entity_id = :id", { id: lease.id })).toBe(0);
      expect(fichiersDe(p.ownerId)).toHaveLength(avant);
    });

    test('panne APRÈS l’écriture du PDF : transaction annulée, fichier supprimé du stockage (pas d’orphelin)', async () => {
      await publierProfessionnel();
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p, { bail: { lease_type: 'professionnel' } });
      const avant = fichiersDe(p.ownerId).length;
      const espion = jest.spyOn(LeaseDocument, 'create').mockRejectedValueOnce(new Error('Panne simulée'));
      try {
        const res = await api().post(`${BASE}/${lease.id}/contrats`).set(p.h).send({});
        expect(res.status).toBe(500);
      } finally {
        espion.mockRestore();
      }
      expect(await compter('documents', "entity_type = 'lease' AND entity_id = :id", { id: lease.id })).toBe(0);
      expect(await compter('audit_logs', "action = 'lease.ajout_document' AND entity_id = :id", { id: lease.id })).toBe(0);
      expect(fichiersDe(p.ownerId)).toHaveLength(avant);
    });

    test('génération : toutes les variables rendues, clauses particulières distinctes, PDF stocké, partagé, notifié, audit', async () => {
      await publierProfessionnel();
      const p = await nouveauProprietaire();
      const { lease, tenant } = await bailActif(p, { bail: { lease_type: 'professionnel' } });
      const loc = await activerLocataire(p, tenant);
      const res = await api().post(`${BASE}/${lease.id}/contrats`).set(p.h).send({ special_clauses: 'Enseigne lumineuse autorisée.' });
      expect(res.status).toBe(201);
      const { contrat, document } = res.body.data;
      expect(contrat).toMatchObject({ version: 1, template_version: 1, special_clauses: 'Enseigne lumineuse autorisée.', lease_id: lease.id });
      expect(document).toMatchObject({ category: 'contrat', mime_type: 'application/pdf', visible_to_tenant: true });
      expect(document).not.toHaveProperty('storage_key');

      const [[ligne]] = await sequelize.query('SELECT content, template_id FROM lease_documents WHERE id = :id', { replacements: { id: contrat.id } });
      expect(ligne.content).not.toMatch(/\{\{/);
      expect(ligne.content).toContain(`${tenant.first_name} ${tenant.last_name}`);
      expect(ligne.content).toContain(lease.reference);
      // Les clauses particulières ne sont PAS mêlées au texte du modèle (§ 53.4).
      expect(ligne.content).not.toContain('Enseigne lumineuse');

      const [[doc]] = await sequelize.query('SELECT storage_key, tenant_id FROM documents WHERE id = :id', { replacements: { id: document.id } });
      expect(doc.tenant_id).toBe(tenant.id);
      const octets = await storage.lire(doc.storage_key);
      expect(octets.subarray(0, 5).toString()).toBe('%PDF-');

      expect(await compter('audit_logs', "action = 'bail.generation_contrat' AND entity_id = :id", { id: lease.id })).toBe(1);
      expect(await compter('notifications', "user_id = :u AND type = 'document_disponible'", { u: loc.user.id })).toBe(1);
      const vus = await api().get(`/api/v1/documents?entity_type=lease&entity_id=${lease.id}`).set(loc.h);
      expect(vus.body.data.items.map((d) => d.id)).toEqual([document.id]);
      expect((await api().get(`/api/v1/documents/${document.id}/fichier`).set(loc.h)).status).toBe(200);

      // Un contrat généré est une pièce probante : ni supprimé, ni retiré au locataire.
      expect((await api().delete(`/api/v1/documents/${document.id}`).set(p.h)).body.error.code).toBe('DOCUMENT_PROTEGE');
      expect((await api().patch(`/api/v1/documents/${document.id}`).set(p.h).send({ visible_to_tenant: false })).body.error.code).toBe('DOCUMENT_PROTEGE');
    });

    test('versions : nouvelle version du modèle sans effet sur le contrat existant ; GET /contrats par version décroissante', async () => {
      await publierProfessionnel();
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p, { bail: { lease_type: 'professionnel' } });
      const v1 = await api().post(`${BASE}/${lease.id}/contrats`).set(p.h).send({});
      expect(v1.status).toBe(201);
      const [[avant]] = await sequelize.query('SELECT content FROM lease_documents WHERE id = :id', { replacements: { id: v1.body.data.contrat.id } });

      // Le super admin publie une nouvelle version (v2) du modèle.
      const [[modele]] = await sequelize.query("SELECT body, title FROM lease_templates WHERE lease_type = 'professionnel' AND version = 1");
      const [[{ n: max }]] = await sequelize.query("SELECT max(version)::int AS n FROM lease_templates WHERE lease_type = 'professionnel'");
      await sequelize.query("UPDATE lease_templates SET status = 'archive' WHERE lease_type = 'professionnel' AND status = 'publie'");
      await sequelize.query(
        "INSERT INTO lease_templates (lease_type, version, title, body, status, published_at) VALUES ('professionnel', :v, :t, :b, 'publie', now())",
        { replacements: { v: max + 1, t: modele.title, b: `${modele.body}\n\nARTICLE NOUVEAU — version révisée.` } }
      );
      const v2 = await api().post(`${BASE}/${lease.id}/contrats`).set(p.h).send({ special_clauses: 'Clause v2' });
      expect(v2.status).toBe(201);
      expect(v2.body.data.contrat).toMatchObject({ version: 2, template_version: max + 1 });
      const [[apres]] = await sequelize.query('SELECT content, template_version FROM lease_documents WHERE id = :id', { replacements: { id: v1.body.data.contrat.id } });
      expect(apres).toEqual({ content: avant.content, template_version: 1 });
      const [[nouveau]] = await sequelize.query('SELECT content FROM lease_documents WHERE id = :id', { replacements: { id: v2.body.data.contrat.id } });
      expect(nouveau.content).toContain('ARTICLE NOUVEAU');

      const liste = await api().get(`${BASE}/${lease.id}/contrats`).set(p.h);
      expect(liste.status).toBe(200);
      expect(liste.body.data.contracts.map((c) => [c.version, c.template_version])).toEqual([[2, max + 1], [1, 1]]);
      expect(liste.body.data.contracts[0]).not.toHaveProperty('content');
      const detail = await api().get(`${BASE}/${lease.id}`).set(p.h);
      expect(detail.body.data.lease.contracts.map((c) => c.version)).toEqual([2, 1]);

      await sequelize.query("UPDATE lease_templates SET status = 'archive' WHERE lease_type = 'professionnel' AND version = :v", { replacements: { v: max + 1 } });
    });

    test('validation et accès : clauses trop longues 422, autre propriétaire 403, bail inconnu 404', async () => {
      const A = await proprietaire();
      await publierProfessionnel();
      const { lease } = await bailActif(A, { bail: { lease_type: 'professionnel' } });
      const ecarts = await verifierStatuts([
        ['post', `${BASE}/${lease.id}/contrats`, { special_clauses: 'x'.repeat(10001) }, 422],
        ['post', `${BASE}/${lease.id}/contrats`, { special_clauses: 42 }, 422],
        ['post', `${BASE}/${UUID_INCONNU}/contrats`, {}, 404],
        ['get', `${BASE}/${UUID_INCONNU}/contrats`, undefined, 404],
      ], A.h);
      expect(ecarts).toEqual([]);
      expect((await api().post(`${BASE}/${lease.id}/contrats`).set(B.h).send({})).status).toBe(403);
      expect((await api().get(`${BASE}/${lease.id}/contrats`).set(B.h)).status).toBe(403);
      expect(await compter('lease_documents', 'lease_id = :id', { id: lease.id })).toBe(0);
    });

    test('concurrence : deux générations simultanées → versions 1 et 2, jamais de doublon', async () => {
      await publierProfessionnel();
      const p = await nouveauProprietaire();
      const { lease } = await bailActif(p, { bail: { lease_type: 'professionnel' } });
      const reponses = await Promise.all([1, 2].map(() => api().post(`${BASE}/${lease.id}/contrats`).set(p.h).send({})));
      expect(reponses.map((r) => r.status)).toEqual([201, 201]);
      const [versions] = await sequelize.query('SELECT version FROM lease_documents WHERE lease_id = :id ORDER BY version', { replacements: { id: lease.id } });
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
    });
  });

  describe('concurrence du cycle de vie', () => {
    test('deux activations simultanées de deux baux du même appartement : un seul actif', async () => {
      const A = await proprietaire();
      const { lease, apartment } = await brouillon(A);
      const tenant2 = await creerLocataire(A);
      const second = await api().post(BASE).set(A.h).send({ apartment_id: apartment.id, tenant_id: tenant2.id, start_date: '2026-09-01', deposit_amount: 0 });
      const reponses = await Promise.all([lease.id, second.body.data.lease.id].map((id) => api().post(`${BASE}/${id}/activer`).set(A.h).send({})));
      expect(reponses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await compter('leases', "apartment_id = :a AND status = 'actif'", { a: apartment.id })).toBe(1);
    });

    test('deux terminaisons simultanées : une seule réussit, une seule entrée d’audit', async () => {
      const A = await proprietaire();
      const { lease } = await bailActif(A);
      const reponses = await Promise.all([1, 2].map(() => api().post(`${BASE}/${lease.id}/terminer`).set(A.h).send({ ended_on: '2026-12-31' })));
      expect(reponses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await compter('audit_logs', "action = 'bail.changement_statut' AND entity_id = :id AND details->>'apres' = 'termine'", { id: lease.id })).toBe(1);
    });
  });

  describe('sécurité', () => {
    let routes;

    beforeAll(async () => {
      const { lease } = await bailActif(B);
      routes = [
        ['get', BASE], ['post', BASE], ['get', `${BASE}/${lease.id}`], ['patch', `${BASE}/${lease.id}`],
        ['post', `${BASE}/${lease.id}/activer`], ['post', `${BASE}/${lease.id}/annuler`], ['post', `${BASE}/${lease.id}/terminer`],
        ['post', `${BASE}/${lease.id}/cloturer`], ['post', `${BASE}/${lease.id}/loyer`], ['get', `${BASE}/${lease.id}/contrats`],
        ['post', `${BASE}/${lease.id}/contrats`],
      ];
    });

    test('authentification : absent, mal formé, expiré, révoqué, rafraîchissement → 401 ; compte désactivé → 403', async () => {
      expect(await verifierMatrice(routes, await jetonsDegrades('proprietaire'))).toEqual([]);
    });

    test('autre propriétaire → 403 sur chaque route ciblée, base inchangée', async () => {
      const A = await proprietaire();
      const { lease } = await bailActif(A);
      const [[avant]] = await sequelize.query('SELECT status, rent_amount, updated_at FROM leases WHERE id = :id', { replacements: { id: lease.id } });
      const ecarts = await verifierStatuts([
        ['get', `${BASE}/${lease.id}`, undefined, 403],
        ['patch', `${BASE}/${lease.id}`, { due_day: 12 }, 403],
        ['post', `${BASE}/${lease.id}/activer`, {}, 403],
        ['post', `${BASE}/${lease.id}/annuler`, { reason: 'Piratage' }, 403],
        ['post', `${BASE}/${lease.id}/terminer`, { ended_on: '2026-12-31' }, 403],
        ['post', `${BASE}/${lease.id}/cloturer`, {}, 403],
        ['post', `${BASE}/${lease.id}/loyer`, { rent_amount: 1, effective_from: '2027-01-01' }, 403],
        ['get', `${BASE}/${lease.id}/contrats`, undefined, 403],
        ['post', `${BASE}/${lease.id}/contrats`, {}, 403],
      ], B.h);
      expect(ecarts).toEqual([]);
      const [[apres]] = await sequelize.query('SELECT status, rent_amount, updated_at FROM leases WHERE id = :id', { replacements: { id: lease.id } });
      expect(apres).toEqual(avant);
      expect(await compter('audit_logs', 'entity_id = :id AND owner_id = :o', { id: lease.id, o: B.ownerId })).toBe(0);
    });

    test('locataire, super admin et propriétaire sans permission → 403 sur toutes les routes', async () => {
      const A = await proprietaire();
      const { tenant } = await bailActif(A);
      const loc = await activerLocataire(A, tenant);
      const sansDroit = await proprietaireSansPermission();
      for (const [qui, h] of [['locataire', loc.h], ['super admin', admin.h], ['sans permission', sansDroit.h]]) {
        const ecarts = [];
        for (const [methode, url] of routes) {
          const res = await api()[methode](url).set(h).send({});
          if (res.status !== 403) ecarts.push(`${qui} ${methode} ${url} → ${res.status}`);
        }
        expect(ecarts).toEqual([]);
      }
    });
  });
});
