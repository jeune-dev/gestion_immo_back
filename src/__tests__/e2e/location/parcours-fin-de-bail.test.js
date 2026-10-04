'use strict';

const {
  api, proprietaireEtLocataire, echeancesDu, payerEspeces, pngTest, compter, fermer, sequelize,
} = require('../../setup/helpers.js');

/**
 * PARCOURS E2E — fin de bail et cycle de la caution (§ 10, 52.3 étapes 5-6, 55).
 *
 * versement de la caution → départ du locataire → état des lieux de sortie
 * comparé à l'entrée → retenue justifiée → contestation → litige → réponse
 * (ajustement) → restitution du solde → clôture du bail → appartement de
 * nouveau disponible. La caution n'entre jamais dans les revenus.
 */
describe('E2E — fin de bail et restitution de la caution', () => {
  afterAll(fermer);

  test('parcours nominal', async () => {
    const { proprio: p, locataire: l, lease, apartment } = await proprietaireEtLocataire();
    const [[{ id: depositId }]] = await sequelize.query('SELECT id FROM deposits WHERE lease_id = :l', { replacements: { l: lease.id } });

    // Versement de la caution (reçu PDF), et loyers soldés jusqu'au départ.
    const v = await api().post(`/api/v1/cautions/${depositId}/versements`).set(p.h).send({ amount: 700000, occurred_on: '2026-09-01', method: 'wave', reference: 'WV-CAUTION' });
    expect(v.body.data.deposit.status).toBe('detenue');
    const [sept, oct] = await echeancesDu(p, lease.id);
    await payerEspeces(p, lease.id, sept.amount_due, { scheduleId: sept.id });
    await payerEspeces(p, lease.id, oct.amount_due, { scheduleId: oct.id });

    // Départ au 31 octobre : échéances suivantes annulées, appartement libéré, décompte ouvert.
    expect((await api().post(`/api/v1/baux/${lease.id}/terminer`).set(p.h).send({ ended_on: '2026-10-31', termination_reason: 'Départ du locataire' })).status).toBe(200);
    expect((await api().get(`/api/v1/appartements/${apartment.id}`).set(p.h)).body.data.apartment.status).toBe('disponible');
    expect(await compter('rent_schedules', "lease_id = :l AND period_start > '2026-10-31' AND status <> 'annule'", { l: lease.id })).toBe(0);
    const [[d1]] = await sequelize.query('SELECT status, refund_due_date FROM deposits WHERE id = :d', { replacements: { d: depositId } });
    expect(d1.status).toBe('restitution_en_cours');
    expect(d1.refund_due_date).toBe('2026-11-30');
    expect(await compter('notifications', "type = 'caution' AND user_id = :u", { u: p.user.id })).toBeGreaterThanOrEqual(1);

    // État des lieux de sortie (entrée non faite dans ce parcours : la comparaison le signale).
    const edl = (await api().post('/api/v1/etats-des-lieux').set(p.h).send({ lease_id: lease.id, type: 'sortie' })).body.data.inspection;
    const items = (await api().get(`/api/v1/etats-des-lieux/${edl.id}`).set(p.h)).body.data.inspection.rooms.flatMap((r) => r.items);
    await api().put(`/api/v1/etats-des-lieux/${edl.id}/saisie`).set(p.h).send({ items: items.map((i, k) => ({ item_id: i.id, condition: k === 0 ? 'degrade' : 'bon', comment: k === 0 ? 'Mur taché' : null })) });
    const photo = await api().post(`/api/v1/etats-des-lieux/${edl.id}/elements/${items[0].id}/photos`).set(p.h).attach('fichier', await pngTest(), 'mur.png');
    expect(photo.status).toBe(201);
    expect((await api().post(`/api/v1/etats-des-lieux/${edl.id}/soumettre`).set(p.h)).status).toBe(200);
    expect((await api().post(`/api/v1/locataire/etats-des-lieux/${edl.id}/accepter`).set(l.h)).status).toBe(200);

    // Retenue justifiée par un justificatif du dossier de caution.
    const j = await api().post(`/api/v1/cautions/${depositId}/justificatifs`).set(p.h).attach('fichier', await pngTest('#00f'), 'devis.png');
    const retenue = await api().post(`/api/v1/cautions/${depositId}/retenues`).set(p.h)
      .send({ amount: 80000, reason: 'degradation', description: 'Remise en peinture du mur taché', justification_document_ids: [j.body.data.document.id], inspection_item_ids: [items[0].id] });
    expect(retenue.status).toBe(201);
    expect(retenue.body.data.deposit.status).toBe('retenue_partielle');

    // Contestation par le locataire → litige → clôture bloquée.
    const tid = retenue.body.data.transaction.id;
    expect((await api().post(`/api/v1/locataire/caution/retenues/${tid}/contester`).set(l.h).send({ message: 'La tache existait déjà à mon entrée.' })).body.data.deposit.status).toBe('litige');
    expect((await api().post(`/api/v1/baux/${lease.id}/cloturer`).set(p.h)).body.error.code).toBe('CAUTION_NON_SOLDEE');

    // Réponse du propriétaire : retenue ajustée à 40 000 ; restitution du solde.
    const rep = await api().post(`/api/v1/cautions/${depositId}/retenues/${tid}/reponse`).set(p.h).send({ response: 'Accord sur la moitié.', outcome: 'ajustee', adjusted_amount: 40000 });
    expect(rep.body.data.deposit).toMatchObject({ amount_withheld: 40000 });
    expect((await api().post(`/api/v1/cautions/${depositId}/restitutions`).set(p.h).send({ amount: 660001, occurred_on: '2026-11-15', method: 'wave' })).status).toBe(422);
    const rest = await api().post(`/api/v1/cautions/${depositId}/restitutions`).set(p.h).send({ amount: 660000, occurred_on: '2026-11-15', method: 'wave' });
    expect(rest.body.data.deposit.status).toBe('restituee');

    // Clôture ; le locataire voit sa caution soldée.
    expect((await api().post(`/api/v1/baux/${lease.id}/cloturer`).set(p.h)).body.data.lease.status).toBe('clos');
    const vue = (await api().get('/api/v1/locataire/caution').set(l.h)).body.data.deposits[0];
    expect(vue).toMatchObject({ amount_received: 700000, amount_withheld: 40000, amount_refunded: 660000, balance: 0 });

    // § 55.4 : la caution n'est pas un revenu.
    const rapport = (await api().get('/api/v1/rapports/financier?du=2026-01-01&au=2026-12-31').set(p.h)).body.data;
    expect((rapport.rapport || rapport).revenus.total).toBe(sept.amount_due + oct.amount_due);
    const caisse = (await api().get('/api/v1/caisse/synthese?du=2026-01-01&au=2026-12-31').set(p.h)).body.data.caisse;
    expect(caisse.cautions).toEqual({ recues: 700000, restituees: 660000, solde: 40000 });
  });
});
