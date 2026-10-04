'use strict';

const crypto = require('crypto');
const {
  api, proprietaireEtLocataire, echeancesDu, compter, fermer, sequelize,
} = require('../../setup/helpers.js');
const {
  PAYDUNYA, simulerFournisseurs, ipn, corpsIpn, enFormulaire, factureDe,
} = require('../../setup/paydunyaSimule.js');

/**
 * PARCOURS E2E — encaisser les loyers par tous les canaux (§ 11–13, 21, 26, 44, 51).
 *
 * Espèces (propriétaire) → preuve Wave (locataire) + validation → paiement
 * intégré PayDunya (IPN au format réel, facture relue, reçue deux fois) →
 * excédent confirmé →
 * remboursement → consultation historique, caisse, quittances, rapport
 * financier et tableau de bord : tous les chiffres doivent concorder.
 */

/** IPN telle que PayDunya la poste : application/x-www-form-urlencoded, tout sous `data`. */
const notifier = (moyenId, corps) => api().post(`/api/v1/webhooks/paydunya/${moyenId}`).type('form').send(enFormulaire(corps));

describe('E2E — encaissement des loyers', () => {
  let fournisseurs;
  beforeAll(() => { fournisseurs = simulerFournisseurs(); });
  afterAll(async () => {
    fournisseurs.restaurer();
    await fermer();
  });

  test('trois canaux, un excédent, un remboursement : historique, caisse, quittances et rapports concordent', async () => {
    const { proprio: p, locataire: l, lease, apartment } = await proprietaireEtLocataire();
    const [sept, oct, nov, dec] = await echeancesDu(p, lease.id);

    // 1. Espèces sur septembre (§ 12) → PAYÉ + quittance.
    const especes = await api().post('/api/v1/paiements/especes').set(p.h)
      .send({ lease_id: lease.id, rent_schedule_id: sept.id, amount: 350000, paid_on: '2026-09-03', comment: 'Remis en main propre' });
    expect(especes.status).toBe(201);
    expect(especes.body.data.receipts).toHaveLength(1);

    // 2. Preuve Wave sur octobre (§ 51.2 mode B) : en attente jusqu'à validation.
    await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'preuve', account_number: '771119988' });
    const preuve = await api().post('/api/v1/locataire/paiements/preuves').set(l.h)
      .send({ rent_schedule_id: oct.id, wallet: 'wave', provider_transaction_id: `WV-${Date.now()}`, amount: 350000 });
    expect((await api().get(`/api/v1/echeances/${oct.id}`).set(p.h)).body.data.schedule.amount_paid).toBe(0);
    expect((await api().post(`/api/v1/paiements/transactions/${preuve.body.data.transaction.id}/valider`).set(p.h)).status).toBe(200);

    // 3. Orange Money intégré via PayDunya sur novembre, avec un EXCÉDENT de 50 000.
    const moyen = (await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: PAYDUNYA })).body.data.provider;
    const init = await api().post('/api/v1/locataire/paiements').set(l.h).set('Idempotency-Key', crypto.randomUUID()).send({ rent_schedule_id: nov.id, wallet: 'orange_money' });
    expect(init.status).toBe(201);
    const ref = init.body.data.transaction.reference;
    // Facture créée chez PayDunya : montant, canal Orange Money, référence, IPN du bon propriétaire.
    const facture = factureDe(ref);
    expect(init.body.data.checkout_url).toBe(`https://app.paydunya.com/sandbox-checkout/invoice/${facture.token}`);
    expect(facture).toMatchObject({ total_amount: 350000, channels: ['orange-money-senegal'], status: 'pending' });
    expect(facture.actions.callback_url).toMatch(new RegExp(`/api/v1/webhooks/paydunya/${moyen.id}$`));
    // Le locataire règle 400 000 sur la page PayDunya ; l'IPN arrive deux fois.
    expect((await notifier(moyen.id, ipn(ref, 400000))).status).toBe(200);
    expect((await notifier(moyen.id, ipn(ref, 400000))).body.data.deja).toBe(true);
    expect(await compter('rent_payments', 'lease_id = :l', { l: lease.id })).toBe(3);

    // L'excédent attend la décision du propriétaire, puis crédite décembre.
    const excedent = (await api().get('/api/v1/paiements/rapprochements?type=excedent').set(p.h)).body.data.items[0];
    expect(excedent.amount).toBe(50000);
    expect((await api().get(`/api/v1/echeances/${dec.id}`).set(p.h)).body.data.schedule.amount_paid).toBe(0);
    expect((await api().post(`/api/v1/paiements/rapprochements/${excedent.id}/resoudre`).set(p.h).send({ note: 'Avance acceptée' })).status).toBe(200);
    expect((await api().get(`/api/v1/echeances/${dec.id}`).set(p.h)).body.data.schedule).toMatchObject({ amount_paid: 50000, status: expect.stringMatching(/partiellement_paye|a_venir|a_payer/) });

    // 4. Côté locataire : 3 quittances, 3 paiements, statut de chaque transaction.
    expect((await api().get('/api/v1/locataire/quittances').set(l.h)).body.data.items).toHaveLength(3);
    expect((await api().get('/api/v1/locataire/paiements').set(l.h)).body.data.items).toHaveLength(3);

    // 5. Remboursement du paiement en espèces : septembre rouvert, quittance annulée.
    const payEspeces = especes.body.data.payment.id;
    expect((await api().post(`/api/v1/paiements/${payEspeces}/rembourser`).set(p.h).send({ reason: 'Erreur d’encaissement', method: 'especes' })).status).toBe(200);
    expect((await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule.status).not.toBe('paye');
    expect((await api().get('/api/v1/locataire/quittances').set(l.h)).body.data.items).toHaveLength(2);

    // 6. Historique de l'appartement (§ 25) : les paiements valides y figurent.
    const historique = (await api().get(`/api/v1/appartements/${apartment.id}/historique?limit=50`).set(p.h)).body.data.items;
    expect(historique.filter((e) => e.type === 'loyer_paye')).toHaveLength(2);

    // 7. Caisse (§ 21) : 350 000 × 2 + 400 000 entrés, 350 000 remboursés ; caution à part.
    const caisse = (await api().get('/api/v1/caisse/synthese?du=2026-01-01&au=2027-12-31').set(p.h)).body.data.caisse;
    expect(caisse.entrees).toBe(350000 + 350000 + 400000);
    expect(caisse.sorties).toBe(350000);
    expect(caisse.solde).toBe(750000);

    // 8. Rapport financier et tableau de bord : mêmes montants que la caisse.
    const financier = (await api().get('/api/v1/rapports/financier?du=2026-01-01&au=2027-12-31').set(p.h)).body.data;
    const rapport = financier.rapport || financier;
    expect(rapport.revenus.total).toBe(750000);
    const [[soldes]] = await sequelize.query(
      'SELECT sum(amount_paid)::int AS paye FROM rent_schedules WHERE lease_id = :l', { replacements: { l: lease.id } }
    );
    expect(soldes.paye).toBe(350000 + 350000 + 50000);
  });

  test('échecs : double clic, session expirée, IPN forgée ou mensongère, paiement déjà effectué', async () => {
    const { proprio: p, locataire: l, lease } = await proprietaireEtLocataire();
    const [sept] = await echeancesDu(p, lease.id);
    const moyen = (await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: PAYDUNYA })).body.data.provider;
    const cle = crypto.randomUUID();
    const [a, b] = await Promise.all([1, 2].map(() => api().post('/api/v1/locataire/paiements').set(l.h).set('Idempotency-Key', cle).send({ rent_schedule_id: sept.id, wallet: 'wave' })));
    expect([a.status, b.status]).toContain(201);
    expect(await compter('payment_transactions', "lease_id = :l AND mode = 'integre'", { l: lease.id })).toBe(1);

    // Session expirée : le jeton d'accès est refusé ; le paiement n'est pas perdu.
    expect((await api().get('/api/v1/locataire/paiements/transactions').set({ Authorization: 'Bearer expiré' })).status).toBe(401);

    const tx = (await api().get('/api/v1/locataire/paiements/transactions').set(l.h)).body.data.items[0];
    // Empreinte fausse (émetteur qui ne connaît pas la clé principale) : refusée, rien ne change.
    const facture = factureDe(tx.reference);
    expect((await notifier(moyen.id, corpsIpn(facture, { empreinteDe: 'pas-la-cle', annonce: { status: 'completed' } }))).status).toBe(401);
    // Empreinte correcte mais IPN MENSONGÈRE (facture encore en attente chez PayDunya) : rien n'est payé.
    const menteuse = await notifier(moyen.id, corpsIpn(facture, { annonce: { status: 'completed', total_amount: 350000 } }));
    expect(menteuse.status).toBe(200);
    expect(menteuse.body.data.traite).toBe(false);
    expect((await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule.amount_paid).toBe(0);
    // Paiement réussi puis tentative de repayer : 409 DEJA_PAYE.
    expect((await notifier(moyen.id, ipn(tx.reference, 350000))).status).toBe(200);
    expect((await api().get(`/api/v1/echeances/${sept.id}`).set(p.h)).body.data.schedule.amount_paid).toBe(350000);
    const repayer = await api().post('/api/v1/locataire/paiements').set(l.h).set('Idempotency-Key', crypto.randomUUID()).send({ rent_schedule_id: sept.id, wallet: 'wave' });
    expect(repayer.status).toBe(409);
    expect(repayer.body.error.code).toBe('DEJA_PAYE');
  });
});
