'use strict';

const {
  bailActif, nouveauProprietaire, compter, fermer, sequelize,
} = require('../../setup/helpers.js');
const { mesurer } = require('../../setup/compteurRequetes.js');
const echeances = require('../../../modules/loyer/service/echeance.service.js');
const { aujourdhui, ajouterMois, ajouterJours } = require('../../../utils/dates.js');

/**
 * Job quotidien « echeances » — prolongation de l'horizon de 12 mois (§ 10).
 *
 * Régression de performance (docs/PERFORMANCE.md) : la présélection SQL
 * retenait tout bail dont la dernière période précédait l'horizon, alors que
 * la suivante tombait APRÈS — chaque jour, une transaction verrouillante par
 * bail actif pour ne rien générer (550 baux : 1 750 requêtes). Seuls les
 * baux dont la prochaine période entre dans l'horizon doivent être repris.
 */
describe('Prolongation de l’horizon des échéances : seuls les baux à prolonger sont traités', () => {
  let p;
  let bail;
  let bailAvecFin;

  beforeAll(async () => {
    p = await nouveauProprietaire();
    ({ lease: bail } = await bailActif(p));
    // Bail de 6 mois : toutes ses périodes existent dès l'activation.
    ({ lease: bailAvecFin } = await bailActif(p, { bail: { end_date: '2027-02-28' } }));
    await echeances.prolongerHorizons(); // état de départ : tous les baux de la base à jour
  });

  afterAll(fermer);

  const nb = (leaseId) => compter('rent_schedules', 'lease_id = :l', { l: leaseId });

  test('horizon déjà complet : UNE seule requête (la présélection), aucune transaction', async () => {
    const m = await mesurer(() => echeances.prolongerHorizons());
    expect(m.resultat).toBe(0);
    expect(m.total).toBe(1);
  });

  test('une période manquante en fin d’horizon est regénérée, pour ce bail seulement', async () => {
    const avant = await nb(bail.id);
    await sequelize.query(
      'DELETE FROM rent_schedules WHERE id = (SELECT id FROM rent_schedules WHERE lease_id = :l ORDER BY period_start DESC LIMIT 1)',
      { replacements: { l: bail.id } }
    );
    const m = await mesurer(() => echeances.prolongerHorizons());
    expect(m.resultat).toBe(1);
    expect(await nb(bail.id)).toBe(avant);
    expect(m.total).toBeLessThanOrEqual(10); // présélection + une transaction de génération
  });

  test('un mois plus tard : chaque bail sans fin gagne UNE période ; le bail terminé dans l’horizon, aucune', async () => {
    const [avant, avantFin] = [await nb(bail.id), await nb(bailAvecFin.id)];
    const dans1Mois = ajouterMois(aujourdhui(), 1);
    await echeances.prolongerHorizons(dans1Mois);
    expect(await nb(bail.id)).toBe(avant + 1);
    expect(await nb(bailAvecFin.id)).toBe(avantFin);
    // Et le même jour, plus rien à faire.
    const m = await mesurer(() => echeances.prolongerHorizons(dans1Mois));
    expect(m.total).toBe(1);
  });

  test('périodicité trimestrielle : prochaine période à +3 mois — rien la veille de son entrée dans l’horizon, tout le jour même', async () => {
    const { lease } = await bailActif(p, { bail: { periodicity: 'trimestriel' } });
    const [[{ dernier }]] = await sequelize.query(
      'SELECT max(period_start)::text AS dernier FROM rent_schedules WHERE lease_id = :l', { replacements: { l: lease.id } }
    );
    const prochain = ajouterMois(dernier, 3);
    const jourEntree = ajouterMois(prochain, -12); // horizon de 12 mois (ECHEANCES_HORIZON_MOIS)
    const veille = ajouterJours(jourEntree, -1);
    const avant = await nb(lease.id);

    const depart = new Date();
    const m = await mesurer(() => echeances.prolongerHorizons(veille));
    expect(await nb(lease.id)).toBe(avant);
    // Une transaction par bail RÉELLEMENT prolongé (les mensuels de la base), aucune de plus.
    const [[{ prolonges }]] = await sequelize.query(
      'SELECT count(DISTINCT lease_id)::int AS prolonges FROM rent_schedules WHERE created_at >= :d',
      { replacements: { d: depart } }
    );
    const transactions = [...m.formes].filter(([f]) => /^START TRANSACTION/i.test(f)).reduce((s, [, n]) => s + n, 0);
    expect(transactions).toBe(prolonges);

    await echeances.prolongerHorizons(jourEntree);
    expect(await nb(lease.id)).toBe(avant + 1);
  });
});
