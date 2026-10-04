'use strict';

const idempotence = require('../../../middlewares/idempotence.middleware.js');
const { statutCharge } = require('../../../modules/paiement/service/allocation.service.js');
const repartition = require('../../../modules/charge/service/repartition.calcul.js');

/**
 * Décision de conservation d'une réponse idempotente (§ 44) et ré-export du
 * statut de charge par le moteur d'imputation — fonctions pures.
 */

// Les modules chargent le pool Sequelize (aucune connexion ouverte) : fermé en fin de suite.
afterAll(() => require('../../../config/db.js').close());

describe('idempotence — aConserver', () => {
  const { aConserver } = idempotence;

  test.each([200, 201, 204, 299])('succès %i : conservé et rejoué', (statut) => {
    expect(aConserver(statut, true, true)).toBe(true);
  });

  test.each([400, 404, 422])('refus définitif %i : conservé (la même requête recevra la même réponse)', (statut) => {
    expect(aConserver(statut, true, true)).toBe(true);
  });

  test.each([
    [401, 'session expirée'], [402, 'abonnement échu'], [403, 'droit retiré'], [409, 'conflit d’état'],
    [429, 'limite de débit'], [500, 'erreur serveur'], [502, 'passerelle'], [503, 'fournisseur indisponible'],
  ])('refus passager %i (%s) : clé LIBÉRÉE pour une nouvelle tentative', (statut) => {
    expect(aConserver(statut, true, true)).toBe(false);
  });

  test('réponse coupée (connexion fermée avant la fin) ou sans corps JSON capturé : clé libérée', () => {
    expect(aConserver(201, false, true)).toBe(false);
    expect(aConserver(201, true, false)).toBe(false);
  });

  test('redirections et statuts informatifs : jamais conservés', () => {
    expect(aConserver(302, true, true)).toBe(false);
    expect(aConserver(304, true, true)).toBe(false);
  });
});

describe('idempotence — middleware sans base (garde d’en-tête)', () => {
  const appeler = (mw, entetes, user = { id: 'u' }) => new Promise((resolve) => {
    mw({ headers: entetes, user, method: 'POST', baseUrl: '/x', path: '/', body: {} }, {}, resolve);
  });

  test('en-tête absent : passe si facultatif, 422 IDEMPOTENCE_REQUISE si obligatoire', async () => {
    expect(await appeler(idempotence(), {})).toBeUndefined();
    const err = await appeler(idempotence({ obligatoire: true }), {});
    expect(err).toMatchObject({ statusCode: 422, code: 'IDEMPOTENCE_REQUISE' });
  });

  test.each(['court', 'a'.repeat(129), 'clé avec espaces', 'cle/avec/slash', 'cle<script>'])('clé invalide « %s » → 422 IDEMPOTENCE_INVALIDE', async (cle) => {
    expect(await appeler(idempotence(), { 'idempotency-key': cle })).toMatchObject({ statusCode: 422, code: 'IDEMPOTENCE_INVALIDE' });
  });

  test('clé fournie sans utilisateur authentifié : ignorée (la garde d’authentification répond)', async () => {
    expect(await appeler(idempotence(), { 'idempotency-key': 'cle-valide-123' }, null)).toBeUndefined();
  });
});

describe('allocation — statutCharge (ré-export du module charge)', () => {
  test('même fonction que la définition unique du module charge', () => {
    expect(statutCharge).toBe(repartition.statutCharge);
  });

  test.each([
    [{ amount: 1000, amount_paid: 1000, due_date: '2026-09-01' }, '2026-09-28', 0, 'paye'],
    [{ amount: 1000, amount_paid: 1200, due_date: '2026-09-01' }, '2026-09-28', 0, 'paye'],
    [{ amount: 1000, amount_paid: 0, due_date: '2026-09-01' }, '2026-09-28', 0, 'en_retard'],
    [{ amount: 1000, amount_paid: 0, due_date: '2026-09-25' }, '2026-09-28', 5, 'a_payer'],
    [{ amount: 1000, amount_paid: 400, due_date: '2026-09-30' }, '2026-09-28', 0, 'partiellement_paye'],
    [{ amount: 1000, amount_paid: 400, due_date: '2026-09-01' }, '2026-09-28', 0, 'en_retard'],
    [{ amount: 1000, amount_paid: 1000, due_date: '2026-09-01', cancelled_at: new Date() }, '2026-09-28', 0, 'annule'],
    [{ amount: '1000', amount_paid: '1000', due_date: '2026-09-01' }, '2026-09-28', 0, 'paye'],
  ])('%j le %s (grâce %i j) → %s', (charge, jour, grace, attendu) => {
    expect(statutCharge(charge, jour, grace)).toBe(attendu);
  });
});
