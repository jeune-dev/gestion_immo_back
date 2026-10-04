'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, bailActif, creerImmeuble, creerAppartement, payerEspeces, fermer, sequelize,
} = require('../../../setup/helpers.js');
const { aujourdhui, ajouterJours, ecartJours, debutMois } = require('../../../../utils/dates.js');

/**
 * Rapports (§ 26) — jeu de données CONSTRUIT PAR L'API (paiement, dépenses,
 * autre revenu, facture commune répartie, travaux, artisan) sur une période
 * glissante qui contient aujourd'hui : chiffres exacts des cinq rapports,
 * export CSV de chacun (mêmes chiffres, injection de formules neutralisée),
 * tri et pagination de la rentabilité, validation et cloisonnement.
 */

jest.setTimeout(120000);

const R = '/api/v1/rapports';
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const JOUR = aujourdhui();
const DU = ajouterJours(JOUR, -40);
const PERIODE = { du: DU, au: JOUR };

/** Découpe un CSV « ; » (guillemets RFC 4180) en lignes de cellules. */
function lireCsv(texte) {
  const lignes = [];
  let ligne = [];
  let cellule = '';
  let dedans = false;
  for (let i = 0; i < texte.length; i += 1) {
    const c = texte[i];
    if (dedans) {
      if (c === '"' && texte[i + 1] === '"') { cellule += '"'; i += 1; } else if (c === '"') dedans = false; else cellule += c;
    } else if (c === '"') dedans = true;
    else if (c === ';') { ligne.push(cellule); cellule = ''; } else if (c === '\r' && texte[i + 1] === '\n') {
      ligne.push(cellule); lignes.push(ligne); ligne = []; cellule = ''; i += 1;
    } else cellule += c;
  }
  if (cellule || ligne.length) { ligne.push(cellule); lignes.push(ligne); }
  return lignes;
}

afterAll(fermer);

describe('Rapports — jeu de données construit par l’API', () => {
  let p;
  let bail;
  let aptVide;
  let artisan;
  let wo;

  beforeAll(async () => {
    p = await nouveauProprietaire();
    // Noms « piégés » : ils doivent sortir neutralisés dans les CSV.
    bail = await bailActif(p, { appartement: { number: '=1+1', rent_amount: 350000 } });
    await sequelize.query("UPDATE buildings SET name = '=HYPERLINK(\"http://pirate\";\"clic\")' WHERE id = :id", { replacements: { id: bail.building.id } });
    await sequelize.query("UPDATE tenants SET first_name = '@SUM(A1)', last_name = '-2+3;\"x\"' WHERE id = :id", { replacements: { id: bail.tenant.id } });
    aptVide = await creerAppartement(p, bail.building.id, { number: 'VIDE', rent_amount: 200000 });
    const cats = Object.fromEntries((await api().get('/api/v1/categories-depenses').set(p.h)).body.data.categories.map((c) => [c.code, c]));

    await payerEspeces(p, bail.lease.id, 350000, { paidOn: JOUR });
    await api().post('/api/v1/caisse/autres-revenus').set(p.h).send({ amount: 10000, method: 'especes', occurred_on: JOUR, label: 'Parking', apartment_id: aptVide.id });
    artisan = (await api().post('/api/v1/artisans').set(p.h).send({ name: '+Artisan formule', trade: 'plombier' })).body.data.contractor;
    wo = (await api().post('/api/v1/travaux').set(p.h).send({ title: 'Chantier rapport', building_id: bail.building.id, apartment_id: aptVide.id, category: 'plomberie', status: 'valide', estimated_amount: 50000 })).body.data.work_order;
    await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'artisan_assigne', contractor_id: artisan.id });
    await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'en_cours' });
    await api().post(`/api/v1/travaux/${wo.id}/depenses`).set(p.h).send({ amount: 40000, method: 'especes', spent_on: JOUR });
    await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'termine', actual_amount: 45000 });
    await api().post('/api/v1/depenses').set(p.h).send({ amount: 5000, method: 'wave', spent_on: JOUR, building_id: bail.building.id, category_id: cats.nettoyage.id });
    const annulee = (await api().post('/api/v1/depenses').set(p.h).send({ amount: 999999, method: 'wave', spent_on: JOUR, building_id: bail.building.id, category_id: cats.nettoyage.id })).body.data.expense;
    await api().post(`/api/v1/depenses/${annulee.id}/annuler`).set(p.h).send({ reason: 'Erreur' });
    // Facture commune de la période : 60 000 en parts égales → 30 000 refacturés au locataire, 30 000 au propriétaire.
    const inv = (await api().post('/api/v1/factures-communes').set(p.h).send({
      building_id: bail.building.id, charge_type: 'eau', period_start: debutMois(JOUR), period_end: JOUR, amount: 60000, allocation_method: 'egale',
    })).body.data.invoice;
    await api().post(`/api/v1/factures-communes/${inv.id}/repartir`).set(p.h).send({});
  }, 120000);

  test('financier : revenus (loyers, autres), dépenses valides par catégorie, bénéfice, charges communes', async () => {
    const res = await api().get(`${R}/financier`).query(PERIODE).set(p.h);
    expect(res.status).toBe(200);
    const r = res.body.data.rapport;
    expect(r.periode).toEqual({ du: DU, au: JOUR, jours: 41 });
    expect(r.revenus).toEqual({ loyers: 350000, charges_recuperees: 0, autres_revenus: 10000, total: 360000 });
    expect(r.depenses.total).toBe(45000);
    expect(r.depenses.par_categorie.map((c) => [c.code, c.total, c.nombre])).toEqual([['travaux', 40000, 1], ['nettoyage', 5000, 1]]);
    expect(r.benefice_net).toBe(315000);
    expect(r.charges).toEqual({
      nombre_factures: 1, factures_total: 60000, refacturees_locataires: 30000, recuperees_locataires: 0, reste_a_recouvrer: 30000, a_charge_proprietaire: 30000,
    });
    expect(r.par_immeuble).toHaveLength(1);
    expect(r.par_immeuble[0]).toMatchObject({ building_id: bail.building.id, revenus: { total: 360000 }, depenses: 45000, benefice_net: 315000 });
    // Impayés à la date de fin, recalculés indépendamment depuis les échéances et allocations.
    const [{ attendu }] = await q(`
      SELECT COALESCE(sum(rs.amount_due - COALESCE((SELECT sum(pa.amount) FROM payment_allocations pa JOIN rent_payments rp ON rp.id = pa.rent_payment_id
                                                     WHERE pa.rent_schedule_id = rs.id AND pa.reversed_at IS NULL AND rp.status = 'valide' AND rp.paid_on <= :au), 0)), 0)::bigint AS attendu
        FROM rent_schedules rs WHERE rs.owner_id = :o AND rs.status <> 'annule' AND rs.due_date <= :au`, { o: p.ownerId, au: JOUR });
    expect(r.impayes.montant).toBe(attendu);
  });

  test('immobilier : occupation actuelle, occupation réelle sur la période, loyers, manque à gagner', async () => {
    const r = (await api().get(`${R}/immobilier`).query(PERIODE).set(p.h)).body.data.rapport;
    const joursOccupes = ecartJours(bail.lease.start_date > DU ? bail.lease.start_date : DU, JOUR) + 1;
    expect(r).toMatchObject({
      immeubles: 1, appartements: 2, occupes: 1, disponibles: 1, taux_occupation: 50, taux_vacance: 50, jours_occupes: joursOccupes,
      loyers: { loyer_mensuel_occupes: 350000, loyer_moyen: 350000, loyer_potentiel: 550000, manque_a_gagner_vacance: 200000 },
    });
    expect(r.taux_occupation_periode).toBe(Math.round((1000 * joursOccupes) / (2 * 41)) / 10);
  });

  test('travaux : créés, terminés, coûts estimé / réel / dépenses liées, artisan payé', async () => {
    const r = (await api().get(`${R}/travaux`).query(PERIODE).set(p.h)).body.data.rapport;
    expect(r).toMatchObject({
      crees_sur_periode: 1, termines: 1, en_cours: 0, termines_sur_periode: 1, en_cours_actuellement: 0,
      couts: { estime: 50000, reel: 45000, depenses_liees: 40000 }, depenses_travaux_periode: 40000,
    });
    expect(r.par_categorie).toEqual([expect.objectContaining({ category: 'plomberie', nombre: 1, termines: 1 })]);
    expect(r.artisans.par_montant).toEqual([expect.objectContaining({ contractor_id: artisan.id, nombre: 1, termines: 1, cout_reel: 45000, montant_paye: 40000 })]);
  });

  test('locataires : actif, arrivée de la période', async () => {
    const r = (await api().get(`${R}/locataires`).query(PERIODE).set(p.h)).body.data.rapport;
    expect(r).toMatchObject({ actifs: 1, actifs_sur_periode: 1, arrivees: { nombre: 1 }, departs: { nombre: 0, baux: [] } });
    expect(r.arrivees.baux[0]).toMatchObject({ lease_id: bail.lease.id, tenant_id: bail.tenant.id, date: JOUR });
  });

  test('rentabilité : chaque appartement, revenus / dépenses rattachés, rang ; tri et pagination', async () => {
    const res = await api().get(`${R}/rentabilite`).query(PERIODE).set(p.h);
    expect(res.status).toBe(200);
    const lignes = Object.fromEntries(res.body.data.items.map((l) => [l.apartment_number, l]));
    expect(lignes['=1+1']).toMatchObject({ loyers: 350000, revenus: 350000, depenses: 0, resultat_net: 350000, rang: 1 });
    expect(lignes.VIDE).toMatchObject({ loyers: 0, autres_revenus: 10000, depenses: 40000, resultat_net: -30000, rang: 2, jours_occupation: 0, taux_occupation: 0 });
    const ordre = async (tri) => (await api().get(`${R}/rentabilite`).query({ ...PERIODE, tri }).set(p.h)).body.data.items.map((l) => l.apartment_number);
    expect(await ordre('resultat_net')).toEqual(['VIDE', '=1+1']);
    expect(await ordre('-depenses')).toEqual(['VIDE', '=1+1']);
    expect(await ordre('revenus')).toEqual(['VIDE', '=1+1']);
    expect(await ordre('-jours_occupation')).toEqual(['=1+1', 'VIDE']);
    expect(await ordre('number')).toEqual(['=1+1', 'VIDE']);
    const page2 = await api().get(`${R}/rentabilite`).query({ ...PERIODE, limit: 1, page: 2 }).set(p.h);
    expect(page2.body.data.items.map((l) => l.apartment_number)).toEqual(['VIDE']);
    expect(page2.body.data.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
    expect((await api().get(`${R}/rentabilite`).query({ ...PERIODE, page: 3, limit: 1 }).set(p.h)).body.data.items).toEqual([]);
    expect((await api().get(`${R}/rentabilite`).query({ ...PERIODE, limit: 1000 }).set(p.h)).body.data.pagination.limit).toBe(100);
    for (const query of [{ tri: 'owner_id' }, { tri: 'resultat_net; DROP TABLE apartments' }, { page: 0 }, { limit: 0 }, { page: -1 }]) {
      expect([query, (await api().get(`${R}/rentabilite`).query({ ...PERIODE, ...query }).set(p.h)).status]).toEqual([query, 422]);
    }
  });

  describe('export CSV de chaque rapport', () => {
    test.each([['financier'], ['immobilier'], ['travaux'], ['locataires'], ['rentabilite']])('%s : BOM, « ; », pièce jointe, formules neutralisées', async (type) => {
      const res = await api().get(`${R}/${type}`).query({ ...PERIODE, format: 'csv' }).set(p.h).buffer(true).parse((r, cb) => {
        let d = ''; r.setEncoding('utf8'); r.on('data', (c) => { d += c; }); r.on('end', () => cb(null, d));
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
      expect(res.headers['content-disposition']).toBe(`attachment; filename="rapport-${type}_${DU}_${JOUR}.csv"`);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.charCodeAt(0)).toBe(0xFEFF);
      const cellules = lireCsv(res.body.slice(1)).flat();
      // Aucune cellule texte ne commence par un caractère de formule.
      for (const c of cellules) {
        if (/^[=+@\t\r]/.test(c) || (/^-/.test(c) && Number.isNaN(Number(c)))) throw new Error(`Cellule dangereuse dans ${type} : ${c}`);
      }
      expect(cellules[0]).toMatch(/^Rapport|^Rentabilité/);
    });

    test('financier : chiffres identiques au JSON ; nom d’immeuble piégé neutralisé', async () => {
      const csv = (await api().get(`${R}/financier`).query({ ...PERIODE, format: 'csv' }).set(p.h)).text;
      const lignes = lireCsv(csv.slice(1));
      const valeur = (libelle) => lignes.find((l) => l[0] === libelle)?.[1];
      expect(valeur('Loyers encaissés')).toBe('350000');
      expect(valeur('Total des revenus (hors caution)')).toBe('360000');
      expect(valeur('Bénéfice net')).toBe('315000');
      expect(valeur('Charges à la charge du propriétaire')).toBe('30000');
      expect(lignes.some((l) => l[0] === '\'=HYPERLINK("http://pirate";"clic")')).toBe(true);
    });

    test('locataires : nom piégé neutralisé et « ; » / guillemets échappés sans décaler les colonnes', async () => {
      const csv = (await api().get(`${R}/locataires`).query({ ...PERIODE, format: 'csv' }).set(p.h)).text;
      const lignes = lireCsv(csv.slice(1));
      const arrivee = lignes.find((l) => l[0] === JOUR);
      expect(arrivee[1]).toBe('\'@SUM(A1) -2+3;"x"');
      expect(arrivee).toHaveLength(7);
    });

    test('rentabilité : le CSV contient TOUTES les lignes même avec une pagination demandée', async () => {
      const csv = (await api().get(`${R}/rentabilite`).query({ ...PERIODE, format: 'csv', limit: 1, page: 1 }).set(p.h)).text;
      const lignes = lireCsv(csv.slice(1));
      expect(lignes.filter((l) => l[2] === "'=1+1" || l[2] === 'VIDE')).toHaveLength(2);
    });

    test('CORRECTIF M12 : export au-delà du plafond de lignes → 422 EXPORT_TROP_VOLUMINEUX (jamais de requête sans borne)', async () => {
      const avant = process.env.EXPORT_MAX_LIGNES;
      process.env.EXPORT_MAX_LIGNES = '1';
      try {
        const res = await api().get(`${R}/rentabilite`).query({ ...PERIODE, format: 'csv' }).set(p.h);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('EXPORT_TROP_VOLUMINEUX');
      } finally {
        process.env.EXPORT_MAX_LIGNES = avant ?? '';
      }
    });
  });
});

describe('Rapports — validation et cloisonnement', () => {
  let p;
  let autre;
  beforeAll(async () => {
    p = await nouveauProprietaire();
    autre = await nouveauProprietaire();
  });

  test.each(['financier', 'immobilier', 'travaux', 'locataires', 'rentabilite'])('%s : paramètres invalides → 422', async (type) => {
    for (const query of [
      {}, { du: '2026-09-01' }, { au: '2026-09-30' }, { du: '2026-09-30', au: '2026-09-01' }, { du: '2026-02-29', au: '2026-03-31' },
      { du: '2020-01-01', au: '2023-01-01' }, { du: '2026-09-01', au: '2026-09-30', format: 'xlsx' }, { du: '2026-09-01', au: '2026-09-30', building_id: 'x' },
      { du: '2026-09-01', au: '2026-09-30', building_id: crypto.randomUUID() },
    ]) {
      expect([type, query, (await api().get(`${R}/${type}`).query(query).set(p.h)).status]).toEqual([type, query, 422]);
    }
  });

  test.each(['financier', 'immobilier', 'travaux', 'locataires', 'rentabilite'])('%s : immeuble d’un autre propriétaire → 403, aucun chiffre divulgué', async (type) => {
    const bat = await creerImmeuble(autre, { name: `Secret ${crypto.randomBytes(3).toString('hex')}` });
    const res = await api().get(`${R}/${type}`).query({ du: '2026-09-01', au: '2026-09-30', building_id: bat.id }).set(p.h);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(bat.name);
  });

  test('propriétaire sans aucune donnée : rapports vides mais complets (zéros, listes vides)', async () => {
    const PER = { du: '2026-09-01', au: '2026-09-30' };
    const f = (await api().get(`${R}/financier`).query(PER).set(p.h)).body.data.rapport;
    expect(f).toMatchObject({ revenus: { total: 0 }, depenses: { total: 0, par_categorie: [] }, benefice_net: 0, par_immeuble: [], impayes: { montant: 0 } });
    const i = (await api().get(`${R}/immobilier`).query(PER).set(p.h)).body.data.rapport;
    expect(i).toMatchObject({ immeubles: 0, appartements: 0, taux_occupation: 0, taux_occupation_periode: 0, par_immeuble: [] });
    const t = (await api().get(`${R}/travaux`).query(PER).set(p.h)).body.data.rapport;
    expect(t).toMatchObject({ crees_sur_periode: 0, par_categorie: [], artisans: { par_montant: [], par_nombre: [] } });
    const l = (await api().get(`${R}/locataires`).query(PER).set(p.h)).body.data.rapport;
    expect(l).toMatchObject({ actifs: 0, arrivees: { nombre: 0 }, departs: { nombre: 0 }, impayes: { total: 0, locataires: [] } });
    const r = await api().get(`${R}/rentabilite`).query(PER).set(p.h);
    expect(r.body.data).toEqual({ items: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1 } });
  });

  test('période d’un seul jour et période maximale (3 ans moins un jour) acceptées', async () => {
    expect((await api().get(`${R}/financier`).query({ du: '2026-09-01', au: '2026-09-01' }).set(p.h)).body.data.rapport.periode.jours).toBe(1);
    expect((await api().get(`${R}/financier`).query({ du: '2023-09-01', au: '2026-08-31' }).set(p.h)).status).toBe(200);
  });
});
