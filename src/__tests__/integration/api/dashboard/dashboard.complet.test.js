'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, bailActif, creerImmeuble, creerAppartement, activerLocataire, fermer, sequelize,
} = require('../../../setup/helpers.js');
const { aujourdhui, ajouterMois, ajouterJours } = require('../../../../utils/dates.js');

/**
 * Tableau de bord (§ 6) et réponses du § 48 — compléments : « à traiter »
 * (factures à répartir, incidents ouverts, travaux en cours), appartement le
 * plus coûteux (12 derniers mois, dépenses valides), événements du jour,
 * graphiques COMPLÉTÉS de zéros (chaque mois présent, même vide, y compris à
 * cheval sur deux années), validation, cloisonnement et cache.
 */

jest.setTimeout(90000);

const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const DB = '/api/v1/dashboard';

afterAll(fermer);

async function depense(p, {
  building, apartment = null, montant, le, statut = 'valide', description = null,
}) {
  await q(`
    INSERT INTO expenses (owner_id, building_id, apartment_id, category_id, amount, method, spent_on, status, description, created_by)
    VALUES (:o, :b, :a, (SELECT id FROM expense_categories WHERE owner_id IS NULL AND code = 'plomberie'), :m, 'especes', :le, :s, :d, :u)`, {
    o: p.ownerId, b: building, a: apartment, m: montant, le, s: statut, d: description, u: p.user.id,
  });
}

describe('Tableau de bord — compléments § 6 / § 48', () => {
  let p;
  let bail;
  let aptCher;
  let aptMoyen;
  const JOUR = aujourdhui();
  const MOIS = JOUR.slice(0, 7);

  beforeAll(async () => {
    p = await nouveauProprietaire();
    bail = await bailActif(p);
    aptCher = await creerAppartement(p, bail.building.id, { number: 'CHER' });
    aptMoyen = await creerAppartement(p, bail.building.id, { number: 'MOYEN' });
    const b = bail.building.id;
    // § 48 « Quel appartement coûte le plus cher ? » (12 derniers mois, dépenses valides).
    await depense(p, { building: b, apartment: aptCher.id, montant: 90000, le: JOUR, description: 'Plomberie du jour' });
    await depense(p, { building: b, apartment: aptCher.id, montant: 10000, le: ajouterMois(JOUR, -3) });
    await depense(p, { building: b, apartment: aptMoyen.id, montant: 60000, le: ajouterMois(JOUR, -1) });
    await depense(p, { building: b, apartment: aptMoyen.id, montant: 500000, le: JOUR, statut: 'annulee' });
    await depense(p, { building: b, apartment: bail.apartment.id, montant: 999999, le: ajouterMois(JOUR, -13) });
    await depense(p, { building: b, montant: 777777, le: JOUR }); // dépense d'immeuble : aucun appartement
    // À traiter : deux factures à répartir, une répartie, une annulée.
    for (const statut of ['brouillon', 'brouillon', 'repartie', 'annulee']) {
      await q(`
        INSERT INTO charge_invoices (owner_id, building_id, charge_type, period_start, period_end, amount, allocation_method, status, created_by)
        VALUES (:o, :b, 'eau', '2026-09-01', '2026-09-30', 1000, 'egale', :s, :u)`, { o: p.ownerId, b, s: statut, u: p.user.id });
    }
    // Incidents ouverts (signalé, en analyse) et clos ; travaux en cours / clos.
    const loc = await activerLocataire(p, bail.tenant);
    const incidents = [];
    for (let i = 0; i < 3; i += 1) {
      incidents.push((await api().post('/api/v1/locataire/incidents').set(loc.h).send({ category: 'fuite', title: `Incident ${i}`, description: 'Description' })).body.data.incident);
    }
    await api().post(`/api/v1/incidents/${incidents[1].id}/analyser`).set(p.h).send({});
    await api().post(`/api/v1/incidents/${incidents[2].id}/rejeter`).set(p.h).send({ reason: 'Hors sujet' });
    for (const status of ['signale', 'valide', 'valide']) {
      await api().post('/api/v1/travaux').set(p.h).send({ title: `Chantier ${status}`, building_id: b, category: 'autre', status });
    }
    const wo = (await api().post('/api/v1/travaux').set(p.h).send({ title: 'Chantier fini', building_id: b, category: 'autre', status: 'valide' })).body.data.work_order;
    await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'en_cours' });
    await api().post(`/api/v1/travaux/${wo.id}/statut`).set(p.h).send({ status: 'termine' });
  }, 120000);

  test('forme complète et « à traiter » exacts', async () => {
    const res = await api().get(DB).set(p.h);
    expect(res.status).toBe(200);
    const d = res.body.data.dashboard;
    expect(d).toMatchObject({
      mois: MOIS, jour: JOUR, building_id: null,
      patrimoine: { immeubles: 1, appartements: 3, occupes: 1, disponibles: 2, taux_occupation: 33.3, taux_vacance: 66.7 },
      travaux_en_cours: 2,
      a_traiter: { factures_a_repartir: 2, incidents_ouverts: 2, preuves_a_valider: 0, a_rapprocher: 0 },
    });
    for (const cle of ['loyers', 'revenus', 'depenses', 'resultat', 'cautions_detenues', 'qui_n_a_pas_paye', 'appartement_le_plus_couteux', 'aujourd_hui', 'genere_le']) {
      expect(d).toHaveProperty(cle);
    }
  });

  test('§ 48 appartement le plus coûteux : 12 derniers mois, dépenses valides, rattachées à un appartement', async () => {
    const d = (await api().get(DB).set(p.h)).body.data.dashboard;
    expect(d.appartement_le_plus_couteux.map((a) => [a.apartment_number, a.depenses, a.nombre])).toEqual([['CHER', 100000, 2], ['MOYEN', 60000, 1]]);
  });

  test('§ 48 que s’est-il passé aujourd’hui : dépense, incidents et travaux du jour, bornés à 20', async () => {
    const d = (await api().get(DB).set(p.h)).body.data.dashboard;
    const types = d.aujourd_hui.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['depense', 'incident_signale', 'travaux_crees', 'travaux_termines']));
    expect(d.aujourd_hui.length).toBeLessThanOrEqual(20);
    const dep = d.aujourd_hui.find((e) => e.type === 'depense' && e.libelle === 'Plomberie du jour');
    expect(dep).toMatchObject({ montant: -90000, apartment_number: 'CHER', ressource_type: 'expense' });
    // La dépense annulée n'apparaît pas.
    expect(d.aujourd_hui.some((e) => e.montant === -500000)).toBe(false);
  });

  test('filtre immeuble : autre immeuble du propriétaire → chiffres de cet immeuble seulement', async () => {
    const vide = await creerImmeuble(p);
    try {
      const d = (await api().get(DB).query({ building_id: vide.id }).set(p.h)).body.data.dashboard;
      expect(d).toMatchObject({
        building_id: vide.id, patrimoine: { immeubles: 1, appartements: 0, taux_occupation: 0 }, travaux_en_cours: 0,
        a_traiter: { factures_a_repartir: 0, incidents_ouverts: 0 }, appartement_le_plus_couteux: [],
      });
    } finally {
      // Le jeu du propriétaire partagé est rétabli : les autres tests du fichier
      // (ordre aléatoire) comptent exactement UN immeuble.
      expect((await api().delete(`/api/v1/immeubles/${vide.id}`).set(p.h)).status).toBe(200);
    }
  });

  test('cache : deux lectures rapprochées renvoient le même calcul (genere_le identique), propre à chaque propriétaire', async () => {
    const r1 = (await api().get(DB).query({ mois: '2025-05' }).set(p.h)).body.data.dashboard;
    const r2 = (await api().get(DB).query({ mois: '2025-05' }).set(p.h)).body.data.dashboard;
    expect(r2.genere_le).toBe(r1.genere_le);
    const autre = await nouveauProprietaire();
    const r3 = (await api().get(DB).query({ mois: '2025-05' }).set(autre.h)).body.data.dashboard;
    expect(r3.patrimoine.appartements).toBe(0);
    expect(r3.a_traiter.factures_a_repartir).toBe(0);
  });

  test('lectures simultanées (écran d’accueil ouvert en rafale) : toutes 200, même résultat', async () => {
    const reponses = await Promise.all([1, 2, 3, 4, 5].map(() => api().get(DB).query({ mois: '2024-02' }).set(p.h)));
    expect(reponses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(reponses.map((r) => r.body.data.dashboard.genere_le)).size).toBe(1);
  });
});

describe('Graphiques (§ 6) : mois complétés de zéros', () => {
  let p;
  beforeAll(async () => { p = await nouveauProprietaire(); });

  const graphiques = (query) => api().get(`${DB}/graphiques`).query(query).set(p.h);

  test('propriétaire sans donnée : 24 mois, tous présents et à zéro, dans l’ordre', async () => {
    const res = await graphiques({ mois_fin: '2026-08', nb_mois: 24 });
    expect(res.status).toBe(200);
    const g = res.body.data.graphiques;
    expect(g.periode).toEqual({ mois_debut: '2024-09', mois_fin: '2026-08', nb_mois: 24, du: '2024-09-01', au: '2026-08-31' });
    const attendus = Array.from({ length: 24 }, (_, i) => ajouterMois('2024-09-01', i).slice(0, 7));
    for (const serie of ['revenus_mensuels', 'depenses_mensuelles', 'loyers_mensuels', 'evolution_patrimoine', 'travaux_par_periode']) {
      expect([serie, g[serie].map((l) => l.mois)]).toEqual([serie, attendus]);
      for (const ligne of g[serie]) {
        for (const [cle, valeur] of Object.entries(ligne)) if (cle !== 'mois') expect([serie, cle, valeur]).toEqual([serie, cle, 0]);
      }
    }
    expect(g.depenses_par_categorie).toEqual([]);
  });

  test('fenêtre à cheval sur deux années ; un seul mois ; 12 mois par défaut', async () => {
    const g = (await graphiques({ mois_fin: '2026-02', nb_mois: 3 })).body.data.graphiques;
    expect(g.revenus_mensuels.map((l) => l.mois)).toEqual(['2025-12', '2026-01', '2026-02']);
    expect(g.periode).toMatchObject({ du: '2025-12-01', au: '2026-02-28' });
    const un = (await graphiques({ mois_fin: '2024-02', nb_mois: 1 })).body.data.graphiques;
    expect(un.periode).toMatchObject({ du: '2024-02-01', au: '2024-02-29' });
    expect(un.depenses_mensuelles).toEqual([{ mois: '2024-02', total: 0 }]);
    const defaut = (await graphiques({})).body.data.graphiques;
    expect(defaut.revenus_mensuels).toHaveLength(12);
    expect(defaut.periode.mois_fin).toBe(aujourdhui().slice(0, 7));
  });

  test('un mois ISOLÉ avec données au milieu de mois vides : valeur exacte, zéros autour', async () => {
    const proprio = await nouveauProprietaire();
    const bat = await creerImmeuble(proprio);
    await depense(proprio, { building: bat.id, montant: 12345, le: '2025-06-15' });
    await depense(proprio, { building: bat.id, montant: 5, le: '2025-06-30' });
    await depense(proprio, { building: bat.id, montant: 1000, le: '2025-07-01', statut: 'annulee' });
    const g = (await api().get(`${DB}/graphiques`).query({ mois_fin: '2025-08', nb_mois: 4 }).set(proprio.h)).body.data.graphiques;
    expect(g.depenses_mensuelles).toEqual([
      { mois: '2025-05', total: 0 }, { mois: '2025-06', total: 12350 }, { mois: '2025-07', total: 0 }, { mois: '2025-08', total: 0 },
    ]);
    expect(g.depenses_par_categorie).toEqual([expect.objectContaining({ code: 'plomberie', total: 12350, nombre: 2 })]);
  });

  test.each([
    [{ nb_mois: 0 }], [{ nb_mois: 25 }], [{ nb_mois: 1.5 }], [{ nb_mois: 'douze' }], [{ mois_fin: '2026-1' }], [{ mois_fin: '2026-13' }],
    [{ mois_fin: '26-01' }], [{ building_id: 'x' }],
  ])('paramètres invalides %j → 422', async (query) => {
    expect((await graphiques(query)).status).toBe(422);
  });

  test.each([[{ mois: '2026-00' }], [{ mois: '2026-9' }], [{ mois: 'septembre' }], [{ building_id: '123' }]])('tableau de bord : %j → 422', async (query) => {
    expect((await api().get(DB).query(query).set(p.h)).status).toBe(422);
  });

  test('immeuble d’un autre propriétaire → 403 (avant tout cache) ; inconnu → 422', async () => {
    const autre = await nouveauProprietaire();
    const batAutre = await creerImmeuble(autre);
    for (const chemin of [DB, `${DB}/graphiques`]) {
      const res = await api().get(chemin).query({ building_id: batAutre.id }).set(p.h);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(batAutre.name);
      expect((await api().get(chemin).query({ building_id: crypto.randomUUID() }).set(p.h)).status).toBe(422);
    }
    // Le propriétaire légitime obtient bien ses chiffres ensuite (le refus n'a rien mis en cache).
    expect((await api().get(DB).query({ building_id: batAutre.id }).set(autre.h)).status).toBe(200);
  });

  test('évolution du patrimoine : un bien créé aujourd’hui compte à la fin du mois courant, pas avant', async () => {
    const proprio = await nouveauProprietaire();
    const bat = await creerImmeuble(proprio);
    await creerAppartement(proprio, bat.id);
    const moisCourant = aujourdhui().slice(0, 7);
    const g = (await api().get(`${DB}/graphiques`).query({ mois_fin: moisCourant, nb_mois: 2 }).set(proprio.h)).body.data.graphiques;
    expect(g.evolution_patrimoine).toEqual([
      { mois: ajouterJours(`${moisCourant}-01`, -1).slice(0, 7), immeubles: 0, appartements: 0 },
      { mois: moisCourant, immeubles: 1, appartements: 1 },
    ]);
  });
});
