'use strict';

const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, creerLocataire, desactiverEdlObligatoire,
  proprietaireEtLocataire, activerLocataire, bailRelatif, reperes, echeancesDu, payerEspeces, pngTest, fermer, compter,
} = require('../../../setup/helpers.js');
const { aujourdhui, ajouterJours, ajouterMois, ecartJours } = require('../../../../utils/dates.js');
const accords = require('../../../../modules/bail/service/accord.service.js');
const relances = require('../../../../modules/loyer/service/relance.service.js');
const recus = require('../../../../modules/paiement/service/recuPaiement.service.js');

/**
 * Consentements du locataire et paiements déclarés :
 *   - bail proposé puis accepté (application ou papier) avant l'activation ;
 *   - nouveau loyer par avenant, appliqué seulement après accord ;
 *   - congé avec préavis, alertes de fin de bail ;
 *   - espèces déclarées, reçu de chaque paiement, contestation d'un
 *     remboursement, relances suspendues pendant qu'une preuve attend ;
 *   - consentement WhatsApp déclaré par le propriétaire avec preuve.
 */

afterAll(fermer);

const notifs = (userId, titre) => compter('notifications', 'user_id = :u AND title = :titre', { u: userId, titre });

/** Propriétaire qui exige l'accord du locataire, brouillon de bail, locataire avec compte. */
async function brouillonAvecLocataire() {
  const proprio = await nouveauProprietaire();
  await desactiverEdlObligatoire(proprio);
  await api().patch('/api/v1/parametres').set(proprio.h).send({ lease_acceptance_policy: 'bloquant' });
  const building = await creerImmeuble(proprio);
  const apartment = await creerAppartement(proprio, building.id);
  const tenant = await creerLocataire(proprio);
  const locataire = await activerLocataire(proprio, tenant);
  const r = reperes();
  const creation = await api().post('/api/v1/baux').set(proprio.h).send({
    apartment_id: apartment.id, tenant_id: tenant.id, start_date: r.debut, due_day: r.jourEcheance, rent_amount: 150000,
  });
  expect(creation.status).toBe(201);
  return { proprio, locataire, tenant, lease: creation.body.data.lease };
}

describe('Accord du locataire sur le bail', () => {
  test('activation refusée sans accord ; proposé, accepté dans l’application, puis activé', async () => {
    const { proprio, locataire, lease } = await brouillonAvecLocataire();
    const refus = await api().post(`/api/v1/baux/${lease.id}/activer`).set(proprio.h).send({});
    expect(refus.status).toBe(409);
    expect(refus.body.error.code).toBe('ACCORD_LOCATAIRE_REQUIS');

    const proposition = await api().post(`/api/v1/baux/${lease.id}/proposer`).set(proprio.h).send({});
    expect(proposition.status).toBe(200);
    expect(proposition.body.data.tenant_has_account).toBe(true);
    expect(await notifs(locataire.user.id, 'Bail à accepter')).toBe(1);

    const enAttente = await api().get('/api/v1/locataire/accords').set(locataire.h);
    expect(enAttente.status).toBe(200);
    expect(enAttente.body.data.leases.map((l) => l.id)).toEqual([lease.id]);

    const accord = await api().post(`/api/v1/locataire/baux/${lease.id}/accepter`).set(locataire.h).send({});
    expect(accord.status).toBe(200);
    expect(accord.body.data.lease).toMatchObject({ acceptance_method: 'application', tenant_accepted_by: locataire.user.id });
    expect((await api().post(`/api/v1/locataire/baux/${lease.id}/accepter`).set(locataire.h).send({})).body.error.code).toBe('DEJA_REPONDU');
    expect((await api().get('/api/v1/locataire/accords').set(locataire.h)).body.data.leases).toEqual([]);

    const activation = await api().post(`/api/v1/baux/${lease.id}/activer`).set(proprio.h).send({});
    expect(activation.status).toBe(200);
  });

  test('modifier le brouillon efface l’accord : le locataire doit accepter la nouvelle version', async () => {
    const { proprio, locataire, lease } = await brouillonAvecLocataire();
    await api().post(`/api/v1/baux/${lease.id}/proposer`).set(proprio.h).send({});
    await api().post(`/api/v1/locataire/baux/${lease.id}/accepter`).set(locataire.h).send({});
    const modif = await api().patch(`/api/v1/baux/${lease.id}`).set(proprio.h).send({ rent_amount: 175000 });
    expect(modif.status).toBe(200);
    expect(modif.body.data.lease).toMatchObject({ tenant_accepted_at: null, proposed_at: null });
    expect((await api().post(`/api/v1/baux/${lease.id}/activer`).set(proprio.h).send({})).body.error.code).toBe('ACCORD_LOCATAIRE_REQUIS');
  });

  test('refus motivé : le bailleur est prévenu, l’activation reste impossible', async () => {
    const { proprio, locataire, lease } = await brouillonAvecLocataire();
    await api().post(`/api/v1/baux/${lease.id}/proposer`).set(proprio.h).send({});
    expect((await api().post(`/api/v1/locataire/baux/${lease.id}/refuser`).set(locataire.h).send({})).status).toBe(422);
    const refus = await api().post(`/api/v1/locataire/baux/${lease.id}/refuser`).set(locataire.h).send({ reason: 'Loyer trop élevé' });
    expect(refus.status).toBe(200);
    expect(await notifs(proprio.user.id, 'Bail refusé')).toBe(1);
    const activation = await api().post(`/api/v1/baux/${lease.id}/activer`).set(proprio.h).send({});
    expect(activation.status).toBe(409);
    expect(activation.body.error.message).toMatch(/refusé/);
  });

  test('bail signé sur papier : document obligatoire, puis activation', async () => {
    const { proprio, lease } = await brouillonAvecLocataire();
    expect((await api().post(`/api/v1/baux/${lease.id}/acceptation-papier`).set(proprio.h).send({})).status).toBe(400);
    const papier = await api().post(`/api/v1/baux/${lease.id}/acceptation-papier`).set(proprio.h).attach('fichier', await pngTest(), 'bail-signe.png');
    expect(papier.status).toBe(200);
    expect(papier.body.data.lease).toMatchObject({ acceptance_method: 'papier', acceptance_document_id: papier.body.data.document.id });
    expect((await api().post(`/api/v1/baux/${lease.id}/activer`).set(proprio.h).send({})).status).toBe(200);
  });

  test('un autre locataire ne voit ni n’accepte le bail', async () => {
    const { proprio, lease } = await brouillonAvecLocataire();
    await api().post(`/api/v1/baux/${lease.id}/proposer`).set(proprio.h).send({});
    const autre = await brouillonAvecLocataire();
    expect((await api().get('/api/v1/locataire/accords').set(autre.locataire.h)).body.data.leases.map((l) => l.id)).not.toContain(lease.id);
    expect([403, 404]).toContain((await api().post(`/api/v1/locataire/baux/${lease.id}/accepter`).set(autre.locataire.h).send({})).status);
  });
});

describe('Nouveau loyer par avenant', () => {
  test('préavis respecté, échéances inchangées avant l’accord, recalculées après', async () => {
    const { proprio, locataire, lease } = await proprietaireEtLocataire({ bail: bailRelatif() });
    const tropTot = await api().post(`/api/v1/baux/${lease.id}/loyer`).set(proprio.h).send({ rent_amount: 200000, effective_from: ajouterJours(aujourdhui(), 5) });
    expect(tropTot.status).toBe(422);
    expect(tropTot.body.error.code).toBe('PREAVIS_AVENANT_INSUFFISANT');

    const effet = ajouterMois(aujourdhui(), 2).slice(0, 8) + '01';
    const avant = await echeancesDu(proprio, lease.id);
    const proposition = await api().post(`/api/v1/baux/${lease.id}/loyer`).set(proprio.h).send({ rent_amount: 200000, effective_from: effet, reason: 'Révision annuelle' });
    expect(proposition.status).toBe(201);
    expect(proposition.body.data.amendment).toMatchObject({ status: 'propose', previous_rent_amount: lease.rent_amount, rent_amount: 200000 });
    expect((await echeancesDu(proprio, lease.id)).map((e) => e.amount_due)).toEqual(avant.map((e) => e.amount_due));
    const doublon = await api().post(`/api/v1/baux/${lease.id}/loyer`).set(proprio.h).send({ rent_amount: 210000, effective_from: effet });
    expect(doublon.body.error.code).toBe('AVENANT_EN_ATTENTE');

    const { amendments } = (await api().get('/api/v1/locataire/accords').set(locataire.h)).body.data;
    expect(amendments).toHaveLength(1);
    const accord = await api().post(`/api/v1/locataire/avenants/${amendments[0].id}/accepter`).set(locataire.h).send({});
    expect(accord.status).toBe(200);
    expect(await notifs(proprio.user.id, 'Nouveau loyer accepté')).toBe(1);

    const apres = await echeancesDu(proprio, lease.id);
    for (const e of apres) {
      if (e.period_start >= effet) expect(e.rent_amount).toBe(200000);
      else expect(e.rent_amount).toBe(lease.rent_amount);
    }
    const detail = await api().get(`/api/v1/baux/${lease.id}`).set(proprio.h);
    expect(detail.body.data.lease.rent_amount).toBe(200000);
    expect(detail.body.data.lease.amendments[0]).toMatchObject({ status: 'accepte', acceptance_method: 'application' });
  });

  test('refusé : le loyer actuel reste ; signé sur papier : appliqué', async () => {
    const { proprio, locataire, lease } = await proprietaireEtLocataire({ bail: bailRelatif() });
    const effet = ajouterJours(aujourdhui(), 45);
    const p1 = await api().post(`/api/v1/baux/${lease.id}/loyer`).set(proprio.h).send({ rent_amount: 190000, effective_from: effet });
    const refus = await api().post(`/api/v1/locataire/avenants/${p1.body.data.amendment.id}/refuser`).set(locataire.h).send({ reason: 'Hausse trop forte' });
    expect(refus.status).toBe(200);
    expect((await api().get(`/api/v1/baux/${lease.id}`).set(proprio.h)).body.data.lease.rent_amount).toBe(lease.rent_amount);

    const p2 = await api().post(`/api/v1/baux/${lease.id}/loyer`).set(proprio.h).send({ rent_amount: 180000, effective_from: effet });
    expect(p2.status).toBe(201);
    const papier = await api().post(`/api/v1/baux/${lease.id}/avenants/${p2.body.data.amendment.id}/acceptation-papier`).set(proprio.h).attach('fichier', await pngTest(), 'avenant.png');
    expect(papier.status).toBe(200);
    expect(papier.body.data.avenant).toMatchObject({ status: 'accepte', acceptance_method: 'papier' });
    expect((await api().get(`/api/v1/baux/${lease.id}`).set(proprio.h)).body.data.lease.rent_amount).toBe(180000);
  });

  test('retiré par le propriétaire : plus rien à accepter', async () => {
    const { proprio, locataire, lease } = await proprietaireEtLocataire({ bail: bailRelatif() });
    const p = await api().post(`/api/v1/baux/${lease.id}/loyer`).set(proprio.h).send({ charges_amount: 20000, effective_from: ajouterJours(aujourdhui(), 40) });
    const annulation = await api().post(`/api/v1/baux/${lease.id}/avenants/${p.body.data.amendment.id}/annuler`).set(proprio.h).send({});
    expect(annulation.body.data.amendment.status).toBe('annule');
    const tard = await api().post(`/api/v1/locataire/avenants/${p.body.data.amendment.id}/accepter`).set(locataire.h).send({});
    expect(tard.status).toBe(409);
    expect(tard.body.error.code).toBe('AVENANT_DEJA_TRAITE');
  });
});

describe('Congé et fin de bail', () => {
  test('préavis du bail exigé ; congé du locataire, retrait, congé du propriétaire motivé', async () => {
    const { proprio, locataire, lease } = await proprietaireEtLocataire({ bail: { ...bailRelatif(), notice_period_months: 2 } });
    const tropTot = await api().post(`/api/v1/locataire/baux/${lease.id}/conge`).set(locataire.h).send({ planned_exit_date: ajouterMois(aujourdhui(), 1) });
    expect(tropTot.status).toBe(422);
    expect(tropTot.body.error.code).toBe('PREAVIS_INSUFFISANT');

    const sortie = ajouterMois(aujourdhui(), 3);
    const conge = await api().post(`/api/v1/locataire/baux/${lease.id}/conge`).set(locataire.h).send({ planned_exit_date: sortie });
    expect(conge.status).toBe(200);
    expect(conge.body.data.lease).toMatchObject({ notice_given_by: 'locataire', planned_exit_date: sortie });
    expect(await notifs(proprio.user.id, 'Congé du locataire')).toBe(1);
    expect((await api().post(`/api/v1/baux/${lease.id}/conge/annuler`).set(proprio.h).send({})).body.error.code).toBe('CONGE_AUTRE_PARTIE');
    expect((await api().post(`/api/v1/locataire/baux/${lease.id}/conge/annuler`).set(locataire.h).send({})).status).toBe(200);

    expect((await api().post(`/api/v1/baux/${lease.id}/conge`).set(proprio.h).send({ planned_exit_date: sortie })).status).toBe(422);
    const congeBailleur = await api().post(`/api/v1/baux/${lease.id}/conge`).set(proprio.h).send({ planned_exit_date: sortie, reason: 'Reprise pour habiter' });
    expect(congeBailleur.status).toBe(200);
    expect(await notifs(locataire.user.id, 'Congé de votre bailleur')).toBe(1);
  });

  test('alertes J-30 puis date dépassée, une seule fois chacune', async () => {
    const { proprio, locataire, lease } = await proprietaireEtLocataire({ bail: { ...bailRelatif(), notice_period_months: 0 } });
    const sortie = ajouterJours(aujourdhui(), 25);
    await api().post(`/api/v1/locataire/baux/${lease.id}/conge`).set(locataire.h).send({ planned_exit_date: sortie });
    expect(await accords.alertesFinDeBail()).toBeGreaterThanOrEqual(1);
    expect(await notifs(proprio.user.id, 'Fin de bail proche')).toBe(1);
    expect(await notifs(locataire.user.id, 'Fin de bail proche')).toBe(1);
    await accords.alertesFinDeBail();
    expect(await notifs(proprio.user.id, 'Fin de bail proche')).toBe(1);
    await accords.alertesFinDeBail(ajouterJours(sortie, 1));
    expect(await notifs(proprio.user.id, 'Date de sortie dépassée')).toBe(1);
  });

  test('alerteFin : seuil le plus proche, date déplacée = nouveau cycle', () => {
    expect(accords.alerteFin('2026-12-31', '2026-11-01', [])).toMatchObject({ seuil: '60', reste: 60 });
    expect(accords.alerteFin('2026-12-31', '2026-12-01', ['2026-12-31:60'])).toMatchObject({ seuil: '30' });
    expect(accords.alerteFin('2026-12-31', '2026-12-26', ['2026-12-31:7'])).toBeNull();
    expect(accords.alerteFin('2026-12-31', '2026-10-01', [])).toBeNull();
    expect(accords.alerteFin('2027-01-15', '2027-01-16', ['2026-12-31:depassee'])).toMatchObject({ seuil: 'depassee' });
  });

  test('fin sans congé : avertissement, et le locataire est prévenu', async () => {
    const { proprio, locataire, lease } = await proprietaireEtLocataire({ bail: bailRelatif() });
    const fin = await api().post(`/api/v1/baux/${lease.id}/terminer`).set(proprio.h).send({ ended_on: aujourdhui() });
    expect(fin.status).toBe(200);
    expect(fin.body.data.avertissements.map((a) => a.code)).toEqual(['CONGE_ABSENT']);
    expect(await notifs(locataire.user.id, 'Fin de votre bail')).toBe(1);
  });
});

describe('Paiements déclarés, reçus et contestations', () => {
  test('espèces déclarées : en attente, rappel au bailleur après 48 h, relances suspendues, puis validées', async () => {
    const { proprio, locataire, lease } = await proprietaireEtLocataire({ bail: bailRelatif() });
    const echeance = (await echeancesDu(proprio, lease.id)).find((e) => e.due_date > aujourdhui() && ecartJours(aujourdhui(), e.due_date) <= 30);
    const declaration = await api().post('/api/v1/locataire/paiements/especes').set(locataire.h)
      .send({ rent_schedule_id: echeance.id, amount: echeance.amount_due, paid_on: aujourdhui() });
    expect(declaration.status).toBe(201);
    expect(declaration.body.data.transaction).toMatchObject({ wallet: 'especes', status: 'en_attente' });
    const doublon = await api().post('/api/v1/locataire/paiements/especes').set(locataire.h)
      .send({ rent_schedule_id: echeance.id, amount: 1000, paid_on: aujourdhui() });
    expect(doublon.body.error.code).toBe('DECLARATION_EN_ATTENTE');
    expect(await notifs(proprio.user.id, 'Espèces à confirmer')).toBe(1);

    // Le bailleur relance ce jour-là précisément : pas de relance pendant que la déclaration attend.
    const decalage = ecartJours(echeance.due_date, aujourdhui());
    await api().patch('/api/v1/parametres').set(proprio.h).send({ reminder_offsets: [decalage] });
    await relances.envoyerRelances(aujourdhui());
    expect(await compter('rent_reminders', 'rent_schedule_id = :e', { e: echeance.id })).toBe(0);

    expect(await recus.rappelerPreuves(new Date(Date.now() + 49 * 3_600_000))).toBeGreaterThanOrEqual(1);
    expect(await notifs(proprio.user.id, 'Espèces déclarées en attente')).toBe(1);
    await recus.rappelerPreuves(new Date(Date.now() + 50 * 3_600_000));
    expect(await notifs(proprio.user.id, 'Espèces déclarées en attente')).toBe(1);

    const validation = await api().post(`/api/v1/paiements/transactions/${declaration.body.data.transaction.id}/valider`).set(proprio.h).send({});
    expect(validation.status).toBe(200);
    expect(validation.body.data.payment).toMatchObject({ method: 'especes', amount: echeance.amount_due });
  });

  test('témoin : déclaration refusée, la relance du jour repart', async () => {
    const { proprio, locataire, lease } = await proprietaireEtLocataire({ bail: bailRelatif() });
    const echeance = (await echeancesDu(proprio, lease.id)).find((e) => e.due_date > aujourdhui() && ecartJours(aujourdhui(), e.due_date) <= 30);
    const declaration = await api().post('/api/v1/locataire/paiements/especes').set(locataire.h)
      .send({ rent_schedule_id: echeance.id, amount: 1000, paid_on: aujourdhui() });
    const refus = await api().post(`/api/v1/paiements/transactions/${declaration.body.data.transaction.id}/rejeter`).set(proprio.h).send({ reason: 'Rien reçu' });
    expect(refus.status).toBe(200);
    await api().patch('/api/v1/parametres').set(proprio.h).send({ reminder_offsets: [ecartJours(echeance.due_date, aujourdhui())] });
    await relances.envoyerRelances(aujourdhui());
    expect(await compter('rent_reminders', 'rent_schedule_id = :e', { e: echeance.id })).toBe(1);
  });

  test('reçu PDF d’un paiement partiel, pour le bailleur et le locataire seulement', async () => {
    const { proprio, locataire, lease } = await proprietaireEtLocataire({ bail: bailRelatif() });
    const [premiere] = await echeancesDu(proprio, lease.id);
    const { payment } = await payerEspeces(proprio, lease.id, 50000, { scheduleId: premiere.id, paidOn: aujourdhui() });
    const pdfBailleur = await api().get(`/api/v1/paiements/${payment.id}/recu`).set(proprio.h).buffer(true);
    expect(pdfBailleur.status).toBe(200);
    expect(pdfBailleur.headers['content-type']).toBe('application/pdf');
    expect(pdfBailleur.body.subarray(0, 4).toString()).toBe('%PDF');
    const pdfLocataire = await api().get(`/api/v1/locataire/paiements/${payment.id}/recu`).set(locataire.h).buffer(true);
    expect(pdfLocataire.status).toBe(200);
    const autre = await proprietaireEtLocataire();
    expect([403, 404]).toContain((await api().get(`/api/v1/locataire/paiements/${payment.id}/recu`).set(autre.locataire.h)).status);
    expect([403, 404]).toContain((await api().get(`/api/v1/paiements/${payment.id}/recu`).set(autre.proprio.h)).status);
  });

  test('remboursement contesté par le locataire, réponse du bailleur tracée', async () => {
    const { proprio, locataire, lease } = await proprietaireEtLocataire({ bail: bailRelatif() });
    const [premiere] = await echeancesDu(proprio, lease.id);
    const { payment } = await payerEspeces(proprio, lease.id, 50000, { scheduleId: premiere.id, paidOn: aujourdhui() });
    expect((await api().post(`/api/v1/locataire/paiements/${payment.id}/contester`).set(locataire.h).send({ message: 'Je conteste ce paiement' })).body.error.code).toBe('CONTESTATION_IMPOSSIBLE');
    await api().post(`/api/v1/paiements/${payment.id}/rembourser`).set(proprio.h).send({ reason: 'Erreur de saisie', method: 'especes' });
    const contestation = await api().post(`/api/v1/locataire/paiements/${payment.id}/contester`).set(locataire.h).send({ message: 'Je n’ai jamais reçu cet argent' });
    expect(contestation.status).toBe(200);
    expect(await notifs(proprio.user.id, 'Remboursement contesté')).toBe(1);
    expect((await api().post(`/api/v1/locataire/paiements/${payment.id}/contester`).set(locataire.h).send({ message: 'Encore une fois' })).body.error.code).toBe('DEJA_CONTESTE');
    const reponse = await api().post(`/api/v1/paiements/${payment.id}/contestation/reponse`).set(proprio.h).send({ response: 'Remis en main propre le 3, reçu signé.' });
    expect(reponse.status).toBe(200);
    expect(reponse.body.data.payment).toMatchObject({ dispute_status: 'resolu' });
    const liste = await api().get('/api/v1/locataire/paiements').set(locataire.h);
    expect(liste.body.data.items.find((p) => p.id === payment.id)).toMatchObject({ dispute_status: 'resolu', dispute_response: expect.any(String) });
  });
});

describe('Consentement WhatsApp déclaré par le propriétaire', () => {
  test('preuve obligatoire, rangée dans les documents de la fiche', async () => {
    const proprio = await nouveauProprietaire();
    const tenant = await creerLocataire(proprio, { whatsapp_consent: true });
    expect(tenant.whatsapp_consent).toBe(false);
    const sansPreuve = await api().post(`/api/v1/locataires/${tenant.id}/consentement-whatsapp`).set(proprio.h).send({ accorde: true });
    expect(sansPreuve.status).toBe(422);
    expect(sansPreuve.body.error.code).toBe('PREUVE_CONSENTEMENT_REQUISE');
    const avecPreuve = await api().post(`/api/v1/locataires/${tenant.id}/consentement-whatsapp`).set(proprio.h)
      .field('accorde', 'true').attach('fichier', await pngTest(), 'accord.png');
    expect(avecPreuve.status).toBe(200);
    expect(avecPreuve.body.data.tenant.whatsapp_consent).toBe(true);
    expect(await compter('documents', "entity_type = 'tenant' AND entity_id = :t AND category = 'justificatif'", { t: tenant.id })).toBe(1);
  });
});
