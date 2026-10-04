'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 20 Dépenses, § 21 Caisse, § 34 hors ligne, § 41 règles métier, § 42
 * annulation plutôt que suppression ; catégories globales / propres.
 */
describe('Dépenses', () => {
  let a;
  let b;
  let building;
  let apartment;
  let autreBuilding;
  let cat;

  const mouvements = async (expenseId) => {
    const [lignes] = await sequelize.query(
      "SELECT * FROM cash_movements WHERE source_type = 'expense' AND source_id = :id ORDER BY created_at",
      { replacements: { id: expenseId } }
    );
    return lignes;
  };

  const depense = (surcharges = {}) => ({
    amount: 100000, method: 'especes', spent_on: '2026-09-23', category_id: cat.travaux.id,
    building_id: building.id, apartment_id: apartment.id, description: 'Réparation plomberie', ...surcharges,
  });

  beforeAll(async () => {
    a = await nouveauProprietaire();
    b = await nouveauProprietaire();
    building = await creerImmeuble(a);
    apartment = await creerAppartement(a, building.id);
    autreBuilding = await creerImmeuble(a);
    const res = await api().get('/api/v1/categories-depenses').set(a.h);
    cat = Object.fromEntries(res.body.data.categories.map((c) => [c.code, c]));
  });
  afterAll(fermer);

  test('création : dépense + UNE sortie de caisse dans la bonne catégorie (§ 41)', async () => {
    const res = await api().post('/api/v1/depenses').set(a.h).send(depense());
    expect(res.status).toBe(201);
    const e = res.body.data.expense;
    expect(e).toMatchObject({ amount: 100000, status: 'valide', building_id: building.id, apartment_id: apartment.id });
    expect(e.category.code).toBe('travaux');
    expect(e.apartment.number).toBe(apartment.number);
    const m = await mouvements(e.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ direction: 'sortie', category: 'travaux', amount: 100000, method: 'especes', building_id: building.id, apartment_id: apartment.id, cancelled_at: null });

    // Groupe « autre » → catégorie de caisse « autre_depense ».
    const taxe = await api().post('/api/v1/depenses').set(a.h).send(depense({ category_id: cat.taxes_impots.id, apartment_id: null, method: 'virement' }));
    expect(taxe.status).toBe(201);
    expect((await mouvements(taxe.body.data.expense.id))[0].category).toBe('autre_depense');

    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'depense.creation' AND entity_id = :id", { replacements: { id: e.id } });
    expect(audit.details.montant).toBe(100000);
  });

  test('validation : immeuble obligatoire, appartement de CET immeuble, montant > 0 (422)', async () => {
    expect((await api().post('/api/v1/depenses').set(a.h).send(depense({ building_id: undefined }))).status).toBe(422);
    expect((await api().post('/api/v1/depenses').set(a.h).send(depense({ amount: 0 }))).status).toBe(422);
    expect((await api().post('/api/v1/depenses').set(a.h).send(depense({ method: 'bitcoin' }))).status).toBe(422);
    const horsImmeuble = await api().post('/api/v1/depenses').set(a.h).send(depense({ building_id: autreBuilding.id }));
    expect(horsImmeuble.status).toBe(422);
    expect((await api().post('/api/v1/depenses').set(a.h).send(depense({ category_id: crypto.randomUUID() }))).status).toBe(422);
    const [[{ n }]] = await sequelize.query("SELECT count(*)::int AS n FROM cash_movements WHERE owner_id = :o AND source_type = 'expense' AND building_id = :b", { replacements: { o: a.ownerId, b: autreBuilding.id } });
    expect(n).toBe(0);
  });

  test('synchronisation hors ligne : même client_reference → même dépense (200), un seul mouvement', async () => {
    const ref = `off-${crypto.randomBytes(6).toString('hex')}`;
    const premier = await api().post('/api/v1/depenses').set(a.h).send(depense({ client_reference: ref }));
    expect(premier.status).toBe(201);
    const second = await api().post('/api/v1/depenses').set(a.h).send(depense({ client_reference: ref, amount: 100000 }));
    expect(second.status).toBe(200);
    expect(second.body.data.expense.id).toBe(premier.body.data.expense.id);
    const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM expenses WHERE owner_id = :o AND client_reference = :ref', { replacements: { o: a.ownerId, ref } });
    expect(n).toBe(1);
    expect(await mouvements(premier.body.data.expense.id)).toHaveLength(1);
    // La référence est propre à chaque propriétaire.
    const bBuilding = await creerImmeuble(b);
    const chezB = await api().post('/api/v1/depenses').set(b.h).send(depense({ client_reference: ref, building_id: bBuilding.id, apartment_id: null }));
    expect(chezB.status).toBe(201);
  });

  test('Idempotency-Key : le double envoi rejoue la réponse d’origine', async () => {
    const cle = `cle-${crypto.randomBytes(8).toString('hex')}`;
    const corps = depense({ amount: 7000 });
    const r1 = await api().post('/api/v1/depenses').set(a.h).set('Idempotency-Key', cle).send(corps);
    const r2 = await api().post('/api/v1/depenses').set(a.h).set('Idempotency-Key', cle).send(corps);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.body.data.expense.id).toBe(r1.body.data.expense.id);
  });

  test('modification : champs descriptifs seulement ; la caisse suit la catégorie', async () => {
    const e = (await api().post('/api/v1/depenses').set(a.h).send(depense())).body.data.expense;
    const modif = await api().patch(`/api/v1/depenses/${e.id}`).set(a.h).send({ category_id: cat.nettoyage.id, description: 'Nettoyage cage escalier', apartment_id: null });
    expect(modif.status).toBe(200);
    expect(modif.body.data.expense).toMatchObject({ description: 'Nettoyage cage escalier', apartment_id: null });
    const [m] = await mouvements(e.id);
    expect(m).toMatchObject({ category: 'nettoyage', apartment_id: null, amount: 100000 });
    // Le montant n'est pas modifiable : retiré par la validation → corps vide → 422.
    expect((await api().patch(`/api/v1/depenses/${e.id}`).set(a.h).send({ amount: 1 })).status).toBe(422);
    expect((await api().patch(`/api/v1/depenses/${e.id}`).set(a.h).send({ apartment_id: (await creerAppartement(a, autreBuilding.id)).id })).status).toBe(422);
  });

  test('annulation (§ 42) : dépense annulée, mouvement annulé ; immuable ensuite', async () => {
    const e = (await api().post('/api/v1/depenses').set(a.h).send(depense())).body.data.expense;
    expect((await api().post(`/api/v1/depenses/${e.id}/annuler`).set(a.h).send({})).status).toBe(422);
    const res = await api().post(`/api/v1/depenses/${e.id}/annuler`).set(a.h).send({ reason: 'Erreur de montant' });
    expect(res.status).toBe(200);
    expect(res.body.data.expense).toMatchObject({ status: 'annulee', cancel_reason: 'Erreur de montant' });
    expect(res.body.data.expense.cancelled_by).toBe(a.user.id);
    const m = await mouvements(e.id);
    expect(m).toHaveLength(1);
    expect(m[0].cancelled_at).not.toBeNull();

    expect((await api().post(`/api/v1/depenses/${e.id}/annuler`).set(a.h).send({ reason: 'Encore' })).status).toBe(409);
    expect((await api().patch(`/api/v1/depenses/${e.id}`).set(a.h).send({ description: 'x' })).status).toBe(409);
    // Jamais supprimée physiquement.
    expect((await api().get(`/api/v1/depenses/${e.id}`).set(a.h)).status).toBe(200);
  });

  test('justificatif : image ou PDF rattaché à la dépense', async () => {
    const e = (await api().post('/api/v1/depenses').set(a.h).send(depense())).body.data.expense;
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).png().toBuffer();
    const photo = await api().post(`/api/v1/depenses/${e.id}/justificatifs`).set(a.h).attach('fichier', png, 'recu.png');
    expect(photo.status).toBe(201);
    expect(photo.body.data.document).toMatchObject({ category: 'justificatif', mime_type: 'image/png', has_thumbnail: true });
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    expect((await api().post(`/api/v1/depenses/${e.id}/justificatifs`).set(a.h).attach('fichier', pdf, 'facture.pdf')).status).toBe(201);
    expect((await api().post(`/api/v1/depenses/${e.id}/justificatifs`).set(a.h).attach('fichier', Buffer.from('<html>pirate</html>'), 'x.png')).status).toBe(400);
    const detail = await api().get(`/api/v1/depenses/${e.id}`).set(a.h);
    expect(detail.body.data.expense.documents).toHaveLength(2);
    expect(detail.body.data.expense.documents[0].url).toMatch(/^\/api\/v1\/documents\/.+\/fichier$/);
  });

  test('liste : filtres immeuble, période, statut ; libellés joints', async () => {
    const p = await nouveauProprietaire();
    const bat = await creerImmeuble(p);
    const autre = await creerImmeuble(p);
    const pc = Object.fromEntries((await api().get('/api/v1/categories-depenses').set(p.h)).body.data.categories.map((c) => [c.code, c]));
    const base = { amount: 1000, method: 'especes', category_id: pc.entretien.id };
    await api().post('/api/v1/depenses').set(p.h).send({ ...base, building_id: bat.id, spent_on: '2026-08-10' });
    await api().post('/api/v1/depenses').set(p.h).send({ ...base, building_id: bat.id, spent_on: '2026-09-10' });
    await api().post('/api/v1/depenses').set(p.h).send({ ...base, building_id: autre.id, spent_on: '2026-09-11' });

    const parImmeuble = await api().get('/api/v1/depenses').query({ building_id: bat.id }).set(p.h);
    expect(parImmeuble.body.data.pagination.total).toBe(2);
    expect(parImmeuble.body.data.items[0]).toMatchObject({ category: { name: 'Entretien' }, building: { name: bat.name } });
    const septembre = await api().get('/api/v1/depenses').query({ du: '2026-09-01', au: '2026-09-30' }).set(p.h);
    expect(septembre.body.data.pagination.total).toBe(2);
    expect((await api().get('/api/v1/depenses').query({ status: 'annulee' }).set(p.h)).body.data.pagination.total).toBe(0);
    expect((await api().get('/api/v1/depenses').query({ method: 'bitcoin' }).set(p.h)).status).toBe(422);
  });

  test('cloisonnement : propriétaire B → 403 ; références d’autrui → 403 ; inconnue → 404', async () => {
    const e = (await api().post('/api/v1/depenses').set(a.h).send(depense())).body.data.expense;
    expect((await api().get(`/api/v1/depenses/${e.id}`).set(b.h)).status).toBe(403);
    expect((await api().patch(`/api/v1/depenses/${e.id}`).set(b.h).send({ description: 'x' })).status).toBe(403);
    expect((await api().post(`/api/v1/depenses/${e.id}/annuler`).set(b.h).send({ reason: 'pirate' })).status).toBe(403);
    // B référence l'immeuble de A.
    expect((await api().post('/api/v1/depenses').set(b.h).send(depense())).status).toBe(403);
    expect((await api().get(`/api/v1/depenses/${crypto.randomUUID()}`).set(a.h)).status).toBe(404);
    const liste = await api().get('/api/v1/depenses').set(b.h);
    expect(liste.body.data.items.every((x) => x.owner_id === b.ownerId)).toBe(true);
  });

  describe('Catégories', () => {
    test('globales en lecture seule (403), catégories propres créées / modifiées / désactivées', async () => {
      const globale = cat.travaux;
      expect(globale.is_global).toBe(true);
      const refus = await api().patch(`/api/v1/categories-depenses/${globale.id}`).set(a.h).send({ name: 'Piratée' });
      expect(refus.status).toBe(403);
      expect(refus.body.error.code).toBe('CATEGORIE_GLOBALE');
      expect((await api().post(`/api/v1/categories-depenses/${globale.id}/desactiver`).set(a.h)).status).toBe(403);

      const creee = await api().post('/api/v1/categories-depenses').set(a.h).send({ name: 'Réparation toiture', cash_group: 'travaux' });
      expect(creee.status).toBe(201);
      expect(creee.body.data.category).toMatchObject({ code: 'reparation_toiture', is_global: false, owner_id: a.ownerId });
      const id = creee.body.data.category.id;
      expect((await api().post('/api/v1/categories-depenses').set(a.h).send({ name: 'Réparation toiture', cash_group: 'travaux' })).status).toBe(409);
      expect((await api().post('/api/v1/categories-depenses').set(a.h).send({ code: 'travaux', name: 'Doublon global', cash_group: 'travaux' })).status).toBe(409);
      expect((await api().post('/api/v1/categories-depenses').set(a.h).send({ name: 'X', cash_group: 'loyer' })).status).toBe(422);

      const modif = await api().patch(`/api/v1/categories-depenses/${id}`).set(a.h).send({ cash_group: 'entretien' });
      expect(modif.body.data.category.cash_group).toBe('entretien');
      // Dépense sur la catégorie propre : caisse classée selon son groupe.
      const e = await api().post('/api/v1/depenses').set(a.h).send(depense({ category_id: id }));
      expect((await mouvements(e.body.data.expense.id))[0].category).toBe('entretien');

      // Invisible pour B, non modifiable par B.
      const listeB = await api().get('/api/v1/categories-depenses').set(b.h);
      expect(listeB.body.data.categories.some((c) => c.id === id)).toBe(false);
      expect((await api().patch(`/api/v1/categories-depenses/${id}`).set(b.h).send({ name: 'Pirate' })).status).toBe(403);
      expect((await api().post('/api/v1/depenses').set(b.h).send(depense({ category_id: id, building_id: (await creerImmeuble(b)).id, apartment_id: null }))).status).toBe(403);

      expect((await api().post(`/api/v1/categories-depenses/${id}/desactiver`).set(a.h)).status).toBe(200);
      expect((await api().post(`/api/v1/categories-depenses/${id}/desactiver`).set(a.h)).status).toBe(409);
      expect((await api().post('/api/v1/depenses').set(a.h).send(depense({ category_id: id }))).status).toBe(422);
      const actives = await api().get('/api/v1/categories-depenses').set(a.h);
      expect(actives.body.data.categories.some((c) => c.id === id)).toBe(false);
      const toutes = await api().get('/api/v1/categories-depenses').query({ inclure_inactives: true }).set(a.h);
      expect(toutes.body.data.categories.some((c) => c.id === id)).toBe(true);
      expect((await api().patch(`/api/v1/categories-depenses/${crypto.randomUUID()}`).set(a.h).send({ name: 'Rien' })).status).toBe(404);
    });
  });
});
