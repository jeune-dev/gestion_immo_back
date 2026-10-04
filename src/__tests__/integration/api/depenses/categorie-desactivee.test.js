'use strict';

const crypto = require('crypto');
const {
  api, nouveauProprietaire, creerImmeuble, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * Audit #22 (FAIBLE) — une dépense dont la catégorie a été DÉSACTIVÉE depuis
 * (§ 20, désactivation plutôt que suppression, § 42) doit rester corrigible :
 * modifier sa description ne « re-choisit » pas la catégorie. Seul un
 * CHANGEMENT de catégorie exige une catégorie active.
 */

describe('Dépense sur une catégorie désactivée depuis', () => {
  let p;
  let immeuble;

  beforeAll(async () => {
    p = await nouveauProprietaire();
    immeuble = await creerImmeuble(p);
  });
  afterAll(fermer);

  const nouvelleCategorie = async (nom) => {
    const res = await api().post('/api/v1/categories-depenses').set(p.h)
      .send({ name: `${nom} ${crypto.randomBytes(3).toString('hex')}`, cash_group: 'entretien' });
    expect(res.status).toBe(201);
    return res.body.data.category;
  };

  /** Dépense créée sur une catégorie, catégorie ensuite désactivée. */
  async function depenseSurCategorieDesactivee() {
    const categorie = await nouvelleCategorie('Groupe électrogène');
    const creation = await api().post('/api/v1/depenses').set(p.h).send({
      amount: 45000, method: 'especes', spent_on: '2026-09-12', category_id: categorie.id, building_id: immeuble.id, description: 'Vidange',
    });
    expect(creation.status).toBe(201);
    expect((await api().post(`/api/v1/categories-depenses/${categorie.id}/desactiver`).set(p.h)).status).toBe(200);
    return { expense: creation.body.data.expense, categorie };
  }

  test('corriger la description reste possible (200) ; catégorie et mouvement de caisse cohérents', async () => {
    const { expense, categorie } = await depenseSurCategorieDesactivee();
    const res = await api().patch(`/api/v1/depenses/${expense.id}`).set(p.h).send({ description: 'Vidange + filtre à huile' });
    expect(res.status).toBe(200);
    expect(res.body.data.expense).toMatchObject({ description: 'Vidange + filtre à huile', category_id: categorie.id });
    const [[m]] = await sequelize.query("SELECT category, label, amount FROM cash_movements WHERE source_type = 'expense' AND source_id = :id", { replacements: { id: expense.id } });
    expect(m).toMatchObject({ category: 'entretien', amount: 45000, label: `${categorie.name} — Vidange + filtre à huile` });
  });

  test('renvoyer la MÊME catégorie (formulaire complet du mobile) n’est pas un changement → 200', async () => {
    const { expense, categorie } = await depenseSurCategorieDesactivee();
    const res = await api().patch(`/api/v1/depenses/${expense.id}`).set(p.h).send({ category_id: categorie.id, description: 'Vidange complète' });
    expect(res.status).toBe(200);
  });

  test('CHOISIR une catégorie désactivée reste refusé (422), sans modification', async () => {
    const { categorie } = await depenseSurCategorieDesactivee();
    const active = await nouvelleCategorie('Jardinage');
    const autre = (await api().post('/api/v1/depenses').set(p.h).send({
      amount: 1000, method: 'especes', spent_on: '2026-09-12', category_id: active.id, building_id: immeuble.id,
    })).body.data.expense;
    const refus = await api().patch(`/api/v1/depenses/${autre.id}`).set(p.h).send({ category_id: categorie.id, description: 'Changement' });
    expect(refus.status).toBe(422);
    const [[e]] = await sequelize.query('SELECT category_id, description FROM expenses WHERE id = :id', { replacements: { id: autre.id } });
    expect(e).toEqual({ category_id: active.id, description: null });
  });

  test('quitter une catégorie désactivée pour une active → 200, la caisse suit le nouveau groupe', async () => {
    const { expense } = await depenseSurCategorieDesactivee();
    const nettoyage = (await api().get('/api/v1/categories-depenses').set(p.h)).body.data.categories.find((c) => c.code === 'nettoyage');
    const res = await api().patch(`/api/v1/depenses/${expense.id}`).set(p.h).send({ category_id: nettoyage.id });
    expect(res.status).toBe(200);
    const [[m]] = await sequelize.query("SELECT category FROM cash_movements WHERE source_type = 'expense' AND source_id = :id", { replacements: { id: expense.id } });
    expect(m.category).toBe('nettoyage');
  });
});
