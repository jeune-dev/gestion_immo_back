'use strict';

const {
  api, nouveauProprietaire, superAdmin, creerImmeuble, fermer, sequelize,
} = require('../../../setup/helpers.js');
const {
  PAYDUNYA_PLATEFORME, simulerFournisseurs, factureDe, corpsIpn, ipn: ipnPaydunya, configurerPlateforme, retirerPlateforme,
} = require('../../../setup/paydunyaSimule.js');
const AbonnementService = require('../../../../modules/abonnement/service/abonnement.service.js');
const { aujourdhui, ajouterMois, ajouterJours } = require('../../../../utils/dates.js');

/**
 * § 31 Abonnements SaaS : formules publiques, souscription PayDunya (clés de
 * la plateforme), activation / prolongation par IPN (facture relue chez
 * PayDunya), idempotence, montant contrôlé, expiration → lecture seule,
 * activation manuelle.
 */

/**
 * Le propriétaire paie (ou annule) sa facture d'abonnement chez PayDunya :
 * renvoie l'IPN que PayDunya posterait, signée de l'empreinte de la clé
 * principale de la PLATEFORME (ou d'une autre clé : falsification).
 */
function ipn(reference, montant, { statut = 'completed', empreinteDe } = {}) {
  return ipnPaydunya(reference, montant, statut, { cles: PAYDUNYA_PLATEFORME, empreinteDe, telephone: '221770000000' });
}

async function abonnementCourant(ownerId) {
  const [[ligne]] = await sequelize.query(
    `SELECT s.*, p.code AS plan_code FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.owner_id = :ownerId AND s.status IN ('essai', 'actif', 'suspendu')`,
    { replacements: { ownerId } }
  );
  return ligne;
}

async function prix(code) {
  const [[plan]] = await sequelize.query('SELECT price FROM subscription_plans WHERE code = :code', { replacements: { code } });
  return Number(plan.price);
}

describe('Abonnements', () => {
  let fournisseurs;

  beforeAll(() => {
    // Identifiants PayDunya de la PLATEFORME, lus à l'appel ; PayDunya simulé :
    // aucune requête réseau pendant les tests.
    configurerPlateforme();
    fournisseurs = simulerFournisseurs();
  });

  afterAll(async () => {
    fournisseurs.restaurer();
    retirerPlateforme();
    await fermer();
  });

  /** Souscription par l'API, puis IPN confirmée : renvoie le paiement. */
  async function payer(p, planCode, mois) {
    const res = await api().post('/api/v1/abonnement/souscrire').set(p.h).send({ plan_code: planCode, months: mois });
    expect(res.status).toBe(201);
    return res.body.data.payment;
  }

  test('formules publiques : actives, triées, fonctionnalités libellées, sans authentification', async () => {
    const res = await api().get('/api/v1/abonnement/plans');
    expect(res.status).toBe(200);
    const codes = res.body.data.plans.map((p) => p.code);
    expect(codes.indexOf('STARTER')).toBeLessThan(codes.indexOf('BUSINESS'));
    const starter = res.body.data.plans.find((p) => p.code === 'STARTER');
    expect(starter).toMatchObject({ currency: 'XOF', billing_period: 'mensuel', limits: { max_buildings: 1 } });
    expect(typeof starter.price).toBe('number');
    expect(starter.features).toContainEqual({ code: 'rapports', label: 'Rapports' });
  });

  test('référentiels publics : énumérations code/libellé et cache HTTP', async () => {
    const res = await api().get('/api/v1/referentiels');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.body.data.enumerations.statut_bail).toContainEqual({ code: 'actif', label: 'Actif' });
    expect(res.body.data.enumerations.fonctionnalite.length).toBeGreaterThan(0);
    expect(res.body.data.enumerations).not.toHaveProperty('mois_par_periodicite');
    expect(res.body.data.correspondances.mois_par_periodicite.trimestriel).toBe(3);
  });

  test('état : essai en cours et consommation des limites', async () => {
    const p = await nouveauProprietaire();
    await creerImmeuble(p);
    const res = await api().get('/api/v1/abonnement').set(p.h);
    expect(res.status).toBe(200);
    const a = res.body.data.abonnement;
    expect(a.actif).toBe(true);
    expect(a.abonnement.status).toBe('essai');
    expect(a.usage.buildings.used).toBe(1);
    expect(a.usage.apartments.used).toBe(0);
    expect(a.usage.whatsapp_this_month).toMatchObject({ used: 0 });
  });

  test('souscription : validation, facture PayDunya créée avec les clés de la plateforme', async () => {
    const p = await nouveauProprietaire();
    expect((await api().post('/api/v1/abonnement/souscrire').set(p.h).send({ plan_code: 'STARTER', months: 13 })).status).toBe(422);
    const inconnu = await api().post('/api/v1/abonnement/souscrire').set(p.h).send({ plan_code: 'INEXISTANT', months: 1 });
    expect(inconnu.status).toBe(422);
    expect(inconnu.body.error.code).toBe('PLAN_INDISPONIBLE');

    const res = await api().post('/api/v1/abonnement/souscrire').set(p.h).send({ plan_code: 'business', months: 3 });
    expect(res.status).toBe(201);
    const paiement = res.body.data.payment;
    const facture = factureDe(paiement.reference);
    expect(res.body.data.checkout_url).toBe(`https://app.paydunya.com/sandbox-checkout/invoice/${facture.token}`);
    expect(paiement.reference).toMatch(/^ABO-\d{8}-\d{6}$/);
    expect(paiement.status).toBe('initie');
    expect(Number(paiement.amount)).toBe((await prix('BUSINESS')) * 3);
    expect(paiement).not.toHaveProperty('raw_payload');

    const appel = fournisseurs.appels.filter((a) => a.url.endsWith('/checkout-invoice/create')).pop();
    expect(appel.url).toBe('https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create');
    expect(appel.entetes).toMatchObject({
      'PAYDUNYA-MASTER-KEY': PAYDUNYA_PLATEFORME.master_key,
      'PAYDUNYA-PRIVATE-KEY': PAYDUNYA_PLATEFORME.private_key,
      'PAYDUNYA-TOKEN': PAYDUNYA_PLATEFORME.token,
    });
    expect(appel.corps.custom_data).toEqual({ reference: paiement.reference });
    expect(appel.corps.invoice.total_amount).toBe(Number(paiement.amount));
    expect(appel.corps.actions.callback_url).toMatch(/\/api\/v1\/webhooks\/abonnement\/paydunya$/);
    // Le jeton de facture identifie le paiement chez PayDunya.
    const [[enregistre]] = await sequelize.query('SELECT provider, provider_transaction_id FROM subscription_payments WHERE reference = :r', { replacements: { r: paiement.reference } });
    expect(enregistre).toEqual({ provider: 'paydunya', provider_transaction_id: `paydunya:${facture.token}` });

    // Aucun abonnement modifié tant que l'IPN n'est pas reçue.
    expect((await abonnementCourant(p.ownerId)).status).toBe('essai');
  });

  test('souscription sans clés PayDunya plateforme : 503 PAIEMENT_NON_CONFIGURE', async () => {
    const p = await nouveauProprietaire();
    retirerPlateforme();
    try {
      const res = await api().post('/api/v1/abonnement/souscrire').set(p.h).send({ plan_code: 'STARTER', months: 1 });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAIEMENT_NON_CONFIGURE');
    } finally {
      configurerPlateforme();
    }
  });

  test('IPN : activation depuis l’essai, doublon idempotent, prolongation du même plan', async () => {
    const p = await nouveauProprietaire();
    const paiement = await payer(p, 'STARTER', 2);
    const montant = Number(paiement.amount);

    const r1 = await AbonnementService.traiterIpnPaydunya(ipn(paiement.reference, montant));
    expect(r1).toMatchObject({ ok: true, statut: 'confirme' });
    const jour = aujourdhui();
    let a = await abonnementCourant(p.ownerId);
    expect(a).toMatchObject({ status: 'actif', plan_code: 'STARTER', current_period_start: jour, current_period_end: ajouterMois(jour, 2) });

    // Confirmation reçue deux fois (§ 56.2) : traitée une seule fois.
    const r2 = await AbonnementService.traiterIpnPaydunya(ipn(paiement.reference, montant));
    expect(r2).toMatchObject({ ok: true, deja: true });
    expect((await abonnementCourant(p.ownerId)).current_period_end).toBe(ajouterMois(jour, 2));

    const [[ligne]] = await sequelize.query('SELECT status, provider_transaction_id, subscription_id, paid_at FROM subscription_payments WHERE reference = :r', { replacements: { r: paiement.reference } });
    expect(ligne).toMatchObject({ status: 'confirme', provider_transaction_id: `paydunya:${factureDe(paiement.reference).token}`, subscription_id: a.id });
    expect(ligne.paid_at).not.toBeNull();

    const [notifs] = await sequelize.query("SELECT title FROM notifications WHERE user_id = :u AND type = 'abonnement'", { replacements: { u: p.user.id } });
    expect(notifs.map((n) => n.title)).toContain('Abonnement activé');

    // Renouvellement anticipé du même plan : prolongé à partir de la fin actuelle.
    const second = await payer(p, 'STARTER', 1);
    await AbonnementService.traiterIpnPaydunya(ipn(second.reference, Number(second.amount)));
    a = await abonnementCourant(p.ownerId);
    expect(a.current_period_end).toBe(ajouterMois(ajouterMois(jour, 2), 1));
    expect(a.current_period_start).toBe(jour);

    const historique = await api().get('/api/v1/abonnement/paiements').set(p.h);
    expect(historique.status).toBe(200);
    expect(historique.body.data.items).toHaveLength(2);
    expect(historique.body.data.items[0]).not.toHaveProperty('raw_payload');

    // Changement de formule : la nouvelle démarre aujourd'hui.
    const pro = await payer(p, 'PRO', 1);
    await AbonnementService.traiterIpnPaydunya(ipn(pro.reference, Number(pro.amount)));
    a = await abonnementCourant(p.ownerId);
    expect(a).toMatchObject({ plan_code: 'PRO', current_period_start: jour, current_period_end: ajouterMois(jour, 1) });
  });

  test('IPN : montant différent refusé, empreinte invalide sans effet, annulation', async () => {
    const p = await nouveauProprietaire();
    const faux = await payer(p, 'STARTER', 1);
    const montant = Number(faux.amount);

    const r = await AbonnementService.traiterIpnPaydunya(ipn(faux.reference, montant - 1000));
    expect(r).toMatchObject({ ok: false, motif: 'montant_incorrect' });
    const [[ligne]] = await sequelize.query('SELECT status FROM subscription_payments WHERE reference = :r', { replacements: { r: faux.reference } });
    expect(ligne.status).toBe('echoue');
    expect((await abonnementCourant(p.ownerId)).status).toBe('essai');

    const autre = await payer(p, 'STARTER', 1);
    const signature = await AbonnementService.traiterIpnPaydunya(ipn(autre.reference, montant, { empreinteDe: 'mauvaise-cle-principale' }));
    expect(signature).toMatchObject({ ok: false, motif: 'signature_invalide' });
    const [[intacte]] = await sequelize.query('SELECT status FROM subscription_payments WHERE reference = :r', { replacements: { r: autre.reference } });
    expect(intacte.status).toBe('initie');

    const annulation = await AbonnementService.traiterIpnPaydunya(ipn(autre.reference, montant, { statut: 'cancelled' }));
    expect(annulation).toMatchObject({ ok: true, statut: 'annule' });
    expect((await abonnementCourant(p.ownerId)).status).toBe('essai');
  });

  test('IPN : le contenu annoncé n’est jamais cru — facture en attente chez PayDunya ou IPN d’annulation rejouée en « completed » : rien n’est activé', async () => {
    const p = await nouveauProprietaire();
    const paiement = await payer(p, 'STARTER', 1);
    const montant = Number(paiement.amount);

    // Empreinte valide, IPN annonçant un paiement réussi : la facture relue est encore en attente.
    const menteuse = corpsIpn(factureDe(paiement.reference), { empreinteDe: PAYDUNYA_PLATEFORME.master_key, annonce: { status: 'completed', total_amount: montant } });
    expect(await AbonnementService.traiterIpnPaydunya(menteuse)).toEqual({ ok: true, statut: 'ignore' });
    const [[attente]] = await sequelize.query('SELECT status FROM subscription_payments WHERE reference = :r', { replacements: { r: paiement.reference } });
    expect(attente.status).toBe('initie');

    // Annulation réelle, puis la même IPN capturée rejouée en « completed ».
    const capturee = ipn(paiement.reference, montant, { statut: 'cancelled' });
    expect(await AbonnementService.traiterIpnPaydunya(capturee)).toMatchObject({ ok: true, statut: 'annule' });
    const rejouee = { data: { ...capturee.data, status: 'completed' } };
    expect(await AbonnementService.traiterIpnPaydunya(rejouee)).toMatchObject({ ok: true, deja: true, statut: 'annule' });
    expect((await abonnementCourant(p.ownerId)).status).toBe('essai');
    expect(fournisseurs.appels.filter((a) => a.url.includes(`/checkout-invoice/confirm/${factureDe(paiement.reference).token}`)).length).toBeGreaterThanOrEqual(3);
  });

  test('expiration : espace en lecture seule (402), puis réabonnement = nouvel abonnement', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query(
      'UPDATE subscriptions SET current_period_start = :debut, current_period_end = :fin, trial_ends_at = :fin WHERE owner_id = :o',
      { replacements: { o: p.ownerId, debut: ajouterJours(aujourdhui(), -20), fin: ajouterJours(aujourdhui(), -1) } }
    );
    const nombre = await AbonnementService.expirerAbonnements();
    expect(nombre).toBeGreaterThanOrEqual(1);
    expect(await abonnementCourant(p.ownerId)).toBeUndefined();

    const ecriture = await api().post('/api/v1/immeubles').set(p.h).send({ name: 'Résidence Expirée', address: 'Plateau', city: 'Dakar' });
    expect(ecriture.status).toBe(402);
    expect(ecriture.body.error.code).toBe('ABONNEMENT_REQUIS');
    expect((await api().get('/api/v1/immeubles').set(p.h)).status).toBe(200);
    const etat = await api().get('/api/v1/abonnement').set(p.h);
    expect(etat.body.data.abonnement.actif).toBe(false);

    const [notifs] = await sequelize.query("SELECT title FROM notifications WHERE user_id = :u AND type = 'abonnement'", { replacements: { u: p.user.id } });
    expect(notifs.map((n) => n.title)).toContain('Abonnement expiré');
    const [audit] = await sequelize.query("SELECT details FROM audit_logs WHERE owner_id = :o AND action = 'abonnement.changement_statut'", { replacements: { o: p.ownerId } });
    expect(audit[0].details.statut).toBe('expire');

    // Réabonnement (service appelé directement : la garde d'écriture de
    // routes.js s'applique aussi à /abonnement/souscrire, voir rapport).
    const { payment } = await AbonnementService.souscrire(p.ownerId, p.user, { plan_code: 'STARTER', months: 1 });
    expect((await AbonnementService.traiterIpnPaydunya(ipn(payment.reference, Number(payment.amount)))).ok).toBe(true);
    const [lignes] = await sequelize.query('SELECT status FROM subscriptions WHERE owner_id = :o ORDER BY created_at', { replacements: { o: p.ownerId } });
    expect(lignes.map((l) => l.status)).toEqual(['expire', 'actif']);
    const reprise = await api().post('/api/v1/immeubles').set(p.h).send({ name: 'Résidence Renouvelée', address: 'Plateau', city: 'Dakar' });
    expect(reprise.status).toBe(201);
  });

  test('activation manuelle par le Super Admin : paiement « manuel » tracé', async () => {
    const p = await nouveauProprietaire();
    const admin = await superAdmin();
    const url = `/api/v1/admin/proprietaires/${p.ownerId}/abonnement/activer`;
    expect((await api().post(url).set(p.h).send({ plan_code: 'PRO', months: 6 })).status).toBe(403);
    expect((await api().post(url).set(admin.h).send({ plan_code: 'PRO', months: 0 })).status).toBe(422);

    const res = await api().post(url).set(admin.h).send({ plan_code: 'PRO', months: 6, note: 'Virement reçu le 27/09' });
    expect(res.status).toBe(201);
    expect(res.body.data.payment).toMatchObject({ provider: 'manuel', status: 'confirme', recorded_by: admin.user.id, months: 6 });
    expect(Number(res.body.data.payment.amount)).toBe((await prix('PRO')) * 6);
    const a = await abonnementCourant(p.ownerId);
    expect(a).toMatchObject({ status: 'actif', plan_code: 'PRO', current_period_end: ajouterMois(aujourdhui(), 6) });

    const etat = await api().get('/api/v1/abonnement').set(p.h);
    expect(etat.body.data.abonnement.plan.code).toBe('PRO');

    const inconnu = await api().post('/api/v1/admin/proprietaires/00000000-0000-4000-8000-000000000000/abonnement/activer')
      .set(admin.h).send({ plan_code: 'PRO', months: 1 });
    expect(inconnu.status).toBe(404);
  });
});
