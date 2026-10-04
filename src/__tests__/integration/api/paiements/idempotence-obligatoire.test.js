'use strict';

const {
  apiBrute, api, proprietaireEtLocataire, compter, fermer,
} = require('../../../setup/helpers.js');
const { aujourdhui } = require('../../../../utils/dates.js');

/**
 * Point faible de l'audit de sécurité — Idempotency-Key OBLIGATOIRE sur les
 * mouvements d'argent : un double envoi (double clic, réseau qui renvoie la
 * requête) ne doit jamais encaisser, rembourser, verser, retenir ou restituer
 * deux fois. Sans clé : 422 IDEMPOTENCE_REQUISE, RIEN n'est écrit.
 * (`apiBrute()` n'ajoute aucune clé, contrairement au client de test `api()`.)
 */

afterAll(fermer);

describe('Idempotency-Key obligatoire sur les mouvements d’argent', () => {
  test('les 5 routes refusent une requête sans clé, sans rien écrire', async () => {
    const { proprio: p, lease } = await proprietaireEtLocataire();
    const encaissement = await api().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, amount: 1000, paid_on: aujourdhui() });
    expect(encaissement.status).toBe(201);
    const paiementId = encaissement.body.data.payment.id;
    const [[{ id: cautionId }]] = await require('../../../setup/helpers.js').sequelize.query('SELECT id FROM deposits WHERE lease_id = :l', { replacements: { l: lease.id } });
    const avant = {
      paiements: await compter('rent_payments', 'lease_id = :l', { l: lease.id }),
      mouvements: await compter('deposit_transactions', 'deposit_id = :d', { d: cautionId }),
    };
    const essais = [
      apiBrute().post('/api/v1/paiements/especes').set(p.h).send({ lease_id: lease.id, amount: 1000, paid_on: aujourdhui() }),
      apiBrute().post(`/api/v1/paiements/${paiementId}/rembourser`).set(p.h).send({ reason: 'Erreur de saisie' }),
      apiBrute().post(`/api/v1/cautions/${cautionId}/versements`).set(p.h).send({ amount: 1000, method: 'especes' }),
      apiBrute().post(`/api/v1/cautions/${cautionId}/restitutions`).set(p.h).send({ amount: 1000, method: 'especes' }),
      apiBrute().post(`/api/v1/cautions/${cautionId}/retenues`).set(p.h).send({ amount: 1000, reason: 'Réparation', description: 'Mur' }),
    ];
    for (const res of await Promise.all(essais)) {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('IDEMPOTENCE_REQUISE');
    }
    expect(await compter('rent_payments', 'lease_id = :l', { l: lease.id })).toBe(avant.paiements);
    expect(await compter('rent_payments', "lease_id = :l AND status = 'rembourse'", { l: lease.id })).toBe(0);
    expect(await compter('deposit_transactions', 'deposit_id = :d', { d: cautionId })).toBe(avant.mouvements);
  });

  test('double envoi avec la MÊME clé : un seul encaissement, la seconde réponse est rejouée', async () => {
    const { proprio: p, lease } = await proprietaireEtLocataire();
    const cle = require('crypto').randomUUID();
    const corps = { lease_id: lease.id, amount: 1000, paid_on: aujourdhui() };
    const a = await apiBrute().post('/api/v1/paiements/especes').set(p.h).set('Idempotency-Key', cle).send(corps);
    const b = await apiBrute().post('/api/v1/paiements/especes').set(p.h).set('Idempotency-Key', cle).send(corps);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(await compter('rent_payments', 'lease_id = :l AND amount = 1000', { l: lease.id })).toBe(1);
  });
});
