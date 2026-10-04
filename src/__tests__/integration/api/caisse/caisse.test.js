'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  api, nouveauProprietaire, creerImmeuble, creerAppartement, fermer, sequelize, compter,
} = require('../../../setup/helpers.js');

/**
 * Caisse (§ 21) : journal des entrées / sorties, synthèse d'une période
 * (entrées, sorties, solde, cautions À PART — § 55.4), autres revenus saisis à
 * la main, annulation d'une saisie manuelle (§ 42). Couverture complète des
 * routes /caisse, /caisse/synthese, /caisse/autres-revenus, /caisse/:id/annuler.
 */

jest.setTimeout(90000);

const C = '/api/v1/caisse';
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** Mouvement inséré en SQL pour maîtriser chaque valeur du jeu de données. */
async function mouvement(p, {
  sens, categorie, montant, le, building = null, apartment = null, method = 'especes', annule = false, source = 'manuel',
}) {
  const [m] = await q(`
    INSERT INTO cash_movements (owner_id, building_id, apartment_id, direction, category, amount, method, occurred_on, label,
                                source_type, is_deposit, cancelled_at)
    VALUES (:o, :building, :apartment, :sens, :categorie, :montant, :method, :le, 'Jeu de test', :source, :depot,
            CASE WHEN :annule THEN now() END)
    RETURNING id`, {
    o: p.ownerId, building, apartment, sens, categorie, montant, method, le, source, depot: categorie === 'caution', annule,
  });
  return m.id;
}

describe('Caisse — couverture complète', () => {
  let p;
  let autre;
  let b1;
  let b2;
  let a1;
  let ids;

  // Jeu de données en LECTURE SEULE : tout test qui écrit (ou tente d'écrire)
  // un mouvement utilise son propre propriétaire, l'ordre est donc indifférent.
  beforeAll(async () => {
    p = await nouveauProprietaire();
    autre = await nouveauProprietaire();
    b1 = await creerImmeuble(p, { name: 'Caisse B1' });
    b2 = await creerImmeuble(p, { name: 'Caisse B2' });
    a1 = await creerAppartement(p, b1.id);
    // Jeu de données de septembre 2026 (et un mouvement d'octobre, hors période).
    ids = {
      loyer: await mouvement(p, { sens: 'entree', categorie: 'loyer', montant: 350000, le: '2026-09-05', building: b1.id, apartment: a1.id }),
      charges: await mouvement(p, { sens: 'entree', categorie: 'charges', montant: 20000, le: '2026-09-06', building: b1.id, method: 'wave' }),
      autre: await mouvement(p, { sens: 'entree', categorie: 'autre_revenu', montant: 15000, le: '2026-09-07', building: b2.id }),
      travaux: await mouvement(p, { sens: 'sortie', categorie: 'travaux', montant: 90000, le: '2026-09-10', building: b1.id, source: 'expense' }),
      entretien: await mouvement(p, { sens: 'sortie', categorie: 'entretien', montant: 10000, le: '2026-09-11', building: b2.id, source: 'expense' }),
      annule: await mouvement(p, { sens: 'entree', categorie: 'loyer', montant: 999999, le: '2026-09-12', building: b1.id, annule: true }),
      cautionRecue: await mouvement(p, { sens: 'entree', categorie: 'caution', montant: 700000, le: '2026-09-01', building: b1.id, source: 'deposit_transaction' }),
      cautionRendue: await mouvement(p, { sens: 'sortie', categorie: 'caution', montant: 200000, le: '2026-09-30', building: b1.id, source: 'deposit_transaction' }),
      octobre: await mouvement(p, { sens: 'entree', categorie: 'loyer', montant: 350000, le: '2026-10-05', building: b1.id }),
    };
  });
  afterAll(fermer);

  describe('GET /caisse/synthese', () => {
    test('septembre : entrées, sorties, solde exacts ; détail par catégorie ; cautions à part ; annulés exclus', async () => {
      const res = await api().get(`${C}/synthese`).query({ du: '2026-09-01', au: '2026-09-30' }).set(p.h);
      expect(res.status).toBe(200);
      const s = res.body.data.caisse;
      expect(s).toMatchObject({
        periode: { du: '2026-09-01', au: '2026-09-30' },
        entrees: 385000, sorties: 100000, solde: 285000,
        cautions: { recues: 700000, restituees: 200000, solde: 500000 },
      });
      const parCategorie = (l) => Object.fromEntries(l.map((x) => [x.category, [x.total, x.nombre]]));
      expect(parCategorie(s.detail_entrees)).toEqual({ loyer: [350000, 1], charges: [20000, 1], autre_revenu: [15000, 1] });
      expect(parCategorie(s.detail_sorties)).toEqual({ travaux: [90000, 1], entretien: [10000, 1] });
    });

    test('filtre immeuble : seulement les mouvements de B2 ; immeuble d’autrui → rien du tout', async () => {
      const res = await api().get(`${C}/synthese`).query({ du: '2026-09-01', au: '2026-09-30', building_id: b2.id }).set(p.h);
      expect(res.body.data.caisse).toMatchObject({ entrees: 15000, sorties: 10000, solde: 5000, cautions: { recues: 0, restituees: 0, solde: 0 } });
      const chezAutre = await api().get(`${C}/synthese`).query({ du: '2026-09-01', au: '2026-09-30', building_id: b1.id }).set(autre.h);
      expect([200, 403]).toContain(chezAutre.status);
      if (chezAutre.status === 200) expect(chezAutre.body.data.caisse).toMatchObject({ entrees: 0, sorties: 0, solde: 0 });
    });

    test('période sans mouvement : zéros ; bornes incluses (un seul jour)', async () => {
      const vide = await api().get(`${C}/synthese`).query({ du: '2025-01-01', au: '2025-01-31' }).set(p.h);
      expect(vide.body.data.caisse).toMatchObject({ entrees: 0, sorties: 0, solde: 0, detail_entrees: [], detail_sorties: [] });
      const jour = await api().get(`${C}/synthese`).query({ du: '2026-09-05', au: '2026-09-05' }).set(p.h);
      expect(jour.body.data.caisse.entrees).toBe(350000);
    });

    test.each([
      [{}], [{ du: '2026-09-01' }], [{ au: '2026-09-30' }], [{ du: '01-09-2026', au: '2026-09-30' }],
      [{ du: '2026-09-01', au: '2026-09-30', building_id: 'x' }],
      // Date inexistante au calendrier : refusée AVANT d'atteindre PostgreSQL (qui répondrait 500).
      [{ du: '2026-02-30', au: '2026-03-31' }], [{ du: '2026-09-01', au: '2026-09-31' }],
      // Période inversée.
      [{ du: '2026-09-30', au: '2026-09-01' }],
    ])('paramètres invalides %j → 422', async (query) => {
      const res = await api().get(`${C}/synthese`).query(query).set(p.h);
      expect(res.status).toBe(422);
    });
  });

  describe('GET /caisse (journal)', () => {
    const journal = (query) => api().get(C).query(query).set(p.h);
    const ids_ = (res) => res.body.data.items.map((m) => m.id);

    test('par défaut : non annulés, SANS cautions, du plus récent au plus ancien, 50 par page', async () => {
      const res = await journal({});
      expect(res.status).toBe(200);
      expect(ids_(res)).toEqual([ids.octobre, ids.entretien, ids.travaux, ids.autre, ids.charges, ids.loyer]);
      expect(res.body.data.pagination).toEqual({ page: 1, limit: 50, total: 6, totalPages: 1 });
      expect(res.body.data.items[5]).toMatchObject({ building: { id: b1.id, name: 'Caisse B1' }, apartment: { id: a1.id } });
    });

    test('cautions sur demande (inclure_cautions ou catégorie « caution »)', async () => {
      expect((await journal({ inclure_cautions: true })).body.data.pagination.total).toBe(8);
      expect(ids_(await journal({ category: 'caution' })).sort()).toEqual([ids.cautionRecue, ids.cautionRendue].sort());
    });

    test('filtres : période, immeuble, sens, catégorie, mode', async () => {
      expect(ids_(await journal({ du: '2026-10-01' }))).toEqual([ids.octobre]);
      expect(ids_(await journal({ au: '2026-09-06' })).sort()).toEqual([ids.loyer, ids.charges].sort());
      expect(ids_(await journal({ building_id: b2.id })).sort()).toEqual([ids.autre, ids.entretien].sort());
      expect(ids_(await journal({ direction: 'sortie' })).sort()).toEqual([ids.travaux, ids.entretien].sort());
      expect(ids_(await journal({ category: 'charges' }))).toEqual([ids.charges]);
      expect(ids_(await journal({ method: 'wave' }))).toEqual([ids.charges]);
    });

    test('pagination : pages, au-delà, plafond ; paramètres invalides 422 ; nouveau propriétaire : vide', async () => {
      const p2 = await journal({ limit: 4, page: 2 });
      expect(ids_(p2)).toEqual([ids.charges, ids.loyer]);
      expect(p2.body.data.pagination).toEqual({ page: 2, limit: 4, total: 6, totalPages: 2 });
      expect(ids_(await journal({ page: 3, limit: 4 }))).toEqual([]);
      expect((await journal({ limit: 5000 })).body.data.pagination.limit).toBe(100);
      for (const query of [{ page: 0 }, { page: -2 }, { limit: 0 }, { direction: 'haut' }, { category: 'x' }, { method: 'x' }, { building_id: '1' }, { du: '2026-02-30' }, { inclure_cautions: 'x' }]) {
        expect([query, (await journal(query)).status]).toEqual([query, 422]);
      }
      expect((await api().get(C).set((await nouveauProprietaire()).h)).body.data.items).toEqual([]);
    });

    test('isolation : le journal de l’autre propriétaire ne contient aucun de ces mouvements', async () => {
      const res = await api().get(C).query({ inclure_cautions: true, limit: 100 }).set(autre.h);
      expect(ids_(res).some((id) => Object.values(ids).includes(id))).toBe(false);
    });
  });

  describe('POST /caisse/autres-revenus', () => {
    const revenu = (surcharges = {}, proprio = p) => api().post(`${C}/autres-revenus`).set(proprio.h).send({
      amount: 12000, method: 'especes', occurred_on: '2026-09-20', label: 'Location parking', building_id: b1.id, ...surcharges,
    });

    test('201 : mouvement d’entrée « autre_revenu » manuel, auteur, audit ; compté dans la synthèse', async () => {
      const proprio = await nouveauProprietaire();
      const bat = await creerImmeuble(proprio);
      const res = await revenu({ building_id: bat.id, label: '  Vente de ferraille  ', owner_id: p.ownerId, direction: 'sortie', category: 'loyer', is_deposit: true }, proprio);
      expect(res.status).toBe(201);
      expect(res.body.message).toBe('Revenu enregistré');
      const m = res.body.data.movement;
      expect(m).toMatchObject({
        owner_id: proprio.ownerId, direction: 'entree', category: 'autre_revenu', source_type: 'manuel', is_deposit: false,
        amount: 12000, label: 'Vente de ferraille', created_by: proprio.user.id, building_id: bat.id, cancelled_at: null,
      });
      const [audit] = await q("SELECT details FROM audit_logs WHERE action = 'caisse.creation' AND entity_id = :id", { id: m.id });
      expect(audit.details).toMatchObject({ montant: 12000, libelle: 'Vente de ferraille' });
      const s = await api().get(`${C}/synthese`).query({ du: '2026-09-20', au: '2026-09-20' }).set(proprio.h);
      expect(s.body.data.caisse).toMatchObject({ entrees: 12000, solde: 12000 });
      // Sans immeuble ni appartement : revenu général de l'espace.
      expect((await revenu({ building_id: null }, proprio)).status).toBe(201);
    });

    test.each([
      ['montant manquant', { amount: undefined }], ['montant nul', { amount: 0 }], ['montant négatif', { amount: -1 }],
      ['montant décimal', { amount: 1.5 }], ['mode inconnu', { method: 'troc' }], ['date manquante', { occurred_on: undefined }],
      ['date inexistante', { occurred_on: '2026-04-31' }], ['libellé trop court', { label: 'x' }], ['libellé trop long', { label: 'x'.repeat(201) }],
      ['libellé manquant', { label: undefined }], ['immeuble non UUID', { building_id: 'b1' }], ['immeuble inconnu', { building_id: crypto.randomUUID() }],
      ['appartement inconnu', { apartment_id: crypto.randomUUID() }],
    ])('%s → 422, rien d’écrit', async (_cas, surcharges) => {
      // Propriétaire dédié : une écriture fautive ne fausserait pas le jeu partagé.
      const proprio = await nouveauProprietaire();
      const envoi = { amount: 12000, method: 'especes', occurred_on: '2026-09-20', label: 'Location parking', ...surcharges };
      for (const [k, v] of Object.entries(envoi)) if (v === undefined) delete envoi[k];
      const avant = await compter('cash_movements', 'owner_id = :o', { o: proprio.ownerId });
      expect((await api().post(`${C}/autres-revenus`).set(proprio.h).send(envoi)).status).toBe(422);
      expect(await compter('cash_movements', 'owner_id = :o', { o: proprio.ownerId })).toBe(avant);
    });

    test('immeuble ou appartement d’un autre propriétaire → 403, rien d’écrit', async () => {
      // Propriétaires dédiés : le patrimoine créé ici ne touche pas au jeu partagé.
      const proprio = await nouveauProprietaire();
      const tiers = await nouveauProprietaire();
      const batAutre = await creerImmeuble(tiers);
      const aptAutre = await creerAppartement(tiers, batAutre.id);
      const avant = await compter('cash_movements', 'owner_id = :o', { o: proprio.ownerId });
      expect((await revenu({ building_id: batAutre.id }, proprio)).status).toBe(403);
      expect((await revenu({ building_id: null, apartment_id: aptAutre.id }, proprio)).status).toBe(403);
      expect(await compter('cash_movements', 'owner_id = :o', { o: proprio.ownerId })).toBe(avant);
    });

    test('Idempotency-Key : le double envoi ne crée qu’UN mouvement', async () => {
      // Propriétaire dédié : le revenu créé ne s'ajoute pas au journal partagé.
      const proprio = await nouveauProprietaire();
      const cle = `rev-${crypto.randomBytes(8).toString('hex')}`;
      const envoi = { amount: 777, method: 'especes', occurred_on: '2026-09-21', label: 'Double clic' };
      const [r1, r2] = await Promise.all([
        api().post(`${C}/autres-revenus`).set(proprio.h).set('Idempotency-Key', cle).send(envoi),
        api().post(`${C}/autres-revenus`).set(proprio.h).set('Idempotency-Key', cle).send(envoi),
      ]);
      expect([r1.status, r2.status]).toContain(201);
      expect(await compter('cash_movements', "owner_id = :o AND label = 'Double clic'", { o: proprio.ownerId })).toBe(1);
    });
  });

  describe('POST /caisse/:id/annuler', () => {
    /**
     * Prépare un propriétaire dédié et un revenu manuel à annuler (par l'API) :
     * les annulations ne touchent jamais au jeu partagé.
     */
    const preparerRevenu = async () => {
      const proprio = await nouveauProprietaire();
      const res = await api().post(`${C}/autres-revenus`).set(proprio.h).send({
        amount: 5000, method: 'especes', occurred_on: '2026-09-25', label: 'À annuler',
      });
      if (res.status !== 201) throw new Error(`Revenu : ${res.status} ${JSON.stringify(res.body)}`);
      return { proprio, m: res.body.data.movement };
    };

    test('saisie manuelle : 200, annulée (jamais supprimée), audit avec motif ; exclue du journal ; 409 si répétée', async () => {
      const { proprio, m } = await preparerRevenu();
      const res = await api().post(`${C}/${m.id}/annuler`).set(proprio.h).send({ reason: 'Erreur de saisie' });
      expect(res.status).toBe(200);
      expect(res.body.data.movement.cancelled_at).not.toBeNull();
      expect(await compter('cash_movements', 'id = :id AND cancelled_at IS NOT NULL', { id: m.id })).toBe(1);
      const [audit] = await q("SELECT details FROM audit_logs WHERE action = 'caisse.suppression' AND entity_id = :id", { id: m.id });
      expect(audit.details).toMatchObject({ montant: 5000, motif: 'Erreur de saisie' });
      expect((await api().get(C).query({ du: '2026-09-25', au: '2026-09-25' }).set(proprio.h)).body.data.items.map((x) => x.id)).not.toContain(m.id);
      const encore = await api().post(`${C}/${m.id}/annuler`).set(proprio.h).send({ reason: 'Encore' });
      expect(encore.status).toBe(409);
      expect(encore.body.error.code).toBe('DEJA_ANNULE');
    });

    test('mouvement automatique (dépense, loyer, caution) → 409 MOUVEMENT_AUTOMATIQUE, inchangé', async () => {
      // Propriétaire dédié et mouvements automatiques identiques à ceux du jeu
      // partagé : une annulation acceptée à tort ne le modifierait pas.
      const proprio = await nouveauProprietaire();
      const bat = await creerImmeuble(proprio);
      const travaux = await mouvement(proprio, { sens: 'sortie', categorie: 'travaux', montant: 90000, le: '2026-09-10', building: bat.id, source: 'expense' });
      const cautionRecue = await mouvement(proprio, { sens: 'entree', categorie: 'caution', montant: 700000, le: '2026-09-01', building: bat.id, source: 'deposit_transaction' });
      for (const id of [travaux, cautionRecue]) {
        const res = await api().post(`${C}/${id}/annuler`).set(proprio.h).send({ reason: 'Tentative' });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('MOUVEMENT_AUTOMATIQUE');
        expect(await compter('cash_movements', 'id = :id AND cancelled_at IS NULL', { id })).toBe(1);
      }
    });

    test('autre propriétaire 403 (inchangé), inconnu 404, id invalide 422, motif invalide 422', async () => {
      const { proprio, m } = await preparerRevenu();
      expect((await api().post(`${C}/${m.id}/annuler`).set(autre.h).send({ reason: 'Pirate' })).status).toBe(403);
      expect(await compter('cash_movements', 'id = :id AND cancelled_at IS NULL', { id: m.id })).toBe(1);
      expect((await api().post(`${C}/${crypto.randomUUID()}/annuler`).set(proprio.h).send({ reason: 'Inconnu' })).status).toBe(404);
      expect((await api().post(`${C}/xyz/annuler`).set(proprio.h).send({ reason: 'Invalide' })).status).toBe(422);
      expect((await api().post(`${C}/${m.id}/annuler`).set(proprio.h).send({})).status).toBe(422);
      expect((await api().post(`${C}/${m.id}/annuler`).set(proprio.h).send({ reason: 'ab' })).status).toBe(422);
    });

    test('annulations simultanées → une seule réussit, un seul audit', async () => {
      const { proprio, m } = await preparerRevenu();
      const reponses = await Promise.all([1, 2, 3].map(() => api().post(`${C}/${m.id}/annuler`).set(proprio.h).send({ reason: 'Course' })));
      expect(reponses.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await compter('audit_logs', "action = 'caisse.suppression' AND entity_id = :id", { id: m.id })).toBe(1);
    });
  });
});
