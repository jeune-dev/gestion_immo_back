'use strict';

const crypto = require('crypto');
const {
  api, nouveauProprietaire, creerImmeuble, pngTest, compter, fermer,
} = require('../../../setup/helpers.js');
const { preparerPreuve, idTransaction } = require('../paiements/outils.paiements.js');

/**
 * CORRECTIF — `Idempotency-Key` sur les routes multipart (§ 44).
 *
 * Le middleware d'idempotence passait AVANT la lecture du formulaire : le
 * corps n'était pas encore lu, l'empreinte ne couvrait ni les champs ni le
 * fichier. La même clé renvoyée avec une AUTRE photo ou une AUTRE preuve de
 * paiement rejouait la première réponse (le second envoi était perdu en
 * silence) au lieu d'être refusée en 422 IDEMPOTENCE_REUTILISEE.
 */

describe('Idempotence des téléversements', () => {
  afterAll(fermer);

  test('photo de travaux : même clé + même fichier → rejoué ; même clé + autre fichier → 422 ; une seule photo', async () => {
    const p = await nouveauProprietaire();
    const bat = await creerImmeuble(p);
    const wo = (await api().post('/api/v1/travaux').set(p.h).send({ title: 'Peinture hall', building_id: bat.id, category: 'peinture' })).body.data.work_order;
    const cle = crypto.randomUUID();
    const envoyer = async (couleur, phase = 'avant') => api().post(`/api/v1/travaux/${wo.id}/photos`).set(p.h).set('Idempotency-Key', cle)
      .field('phase', phase).attach('fichier', await pngTest(couleur), 'photo.png');

    const premier = await envoyer('#f00');
    expect(premier.status).toBe(201);
    const rejoue = await envoyer('#f00');
    expect(rejoue.status).toBe(201);
    expect(rejoue.headers['idempotent-replayed']).toBe('true');

    const autreFichier = await envoyer('#00f');
    expect(autreFichier.status).toBe(422);
    expect(autreFichier.body.error.code).toBe('IDEMPOTENCE_REUTILISEE');
    const autreChamp = await envoyer('#f00', 'apres');
    expect(autreChamp.status).toBe(422);

    expect(await compter('work_photos', 'work_order_id = :w', { w: wo.id })).toBe(1);
  });

  test('preuve de paiement en multipart : même clé + autre référence de transaction → 422, une seule preuve', async () => {
    const { loc, echeances } = await preparerPreuve();
    const cle = crypto.randomUUID();
    const envoyer = (reference) => api().post('/api/v1/locataire/paiements/preuves').set(loc.h).set('Idempotency-Key', cle)
      .field('rent_schedule_id', echeances[0].id).field('wallet', 'wave')
      .field('provider_transaction_id', reference).field('amount', String(echeances[0].amount_due || 350000));

    const premiere = idTransaction();
    const ok = await envoyer(premiere);
    expect(ok.status).toBe(201);
    expect((await envoyer(premiere)).headers['idempotent-replayed']).toBe('true');
    const autre = await envoyer(idTransaction());
    expect(autre.status).toBe(422);
    expect(autre.body.error.code).toBe('IDEMPOTENCE_REUTILISEE');
    expect(await compter('payment_transactions', 'rent_schedule_id = :e', { e: echeances[0].id })).toBe(1);
  });
});
