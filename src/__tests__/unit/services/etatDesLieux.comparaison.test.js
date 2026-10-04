'use strict';

const { trameDesPieces, elementsParDefaut, normaliser, PIECES_MAX } = require('../../../modules/etatDesLieux/service/trame.service.js');
const { comparerEtatsDesLieux } = require('../../../modules/etatDesLieux/service/comparaison.service.js');

/**
 * § 52.3 étape 1 (trame de pièces selon le type d'appartement) et étape 5
 * (comparaison automatique entrée / sortie, élément par élément).
 */
describe('Trame de pièces (§ 52.3 étape 1)', () => {
  const noms = (trame) => trame.map((r) => r.name);
  const elements = (trame, nom) => trame.find((r) => r.name === nom).items.map((i) => i.element);

  test('F3 : séjour, deux chambres, cuisine, salle de bain, WC, balcon', () => {
    const t = trameDesPieces('f3', null, false);
    expect(noms(t)).toEqual(['Salon / Séjour', 'Chambre 1', 'Chambre 2', 'Cuisine', 'Salle de bain', 'WC', 'Balcon / Terrasse']);
    expect(t.map((r) => r.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(elements(t, 'Chambre 1')).toEqual(['murs', 'sols', 'plafond', 'portes', 'fenetres', 'electricite']);
    expect(elements(t, 'Cuisine')).toContain('plomberie');
    expect(elements(t, 'Cuisine')).not.toContain('sanitaires');
    expect(elements(t, 'Salle de bain')).toEqual(expect.arrayContaining(['plomberie', 'sanitaires']));
    expect(elements(t, 'WC')).toEqual(expect.arrayContaining(['plomberie', 'sanitaires']));
    expect(t.flatMap((r) => r.items).some((i) => i.element === 'mobilier')).toBe(false);
  });

  test('rooms_count de l’appartement prioritaire sur le type ; une seule chambre sans numéro', () => {
    expect(noms(trameDesPieces('f4', 6))).toEqual(expect.arrayContaining(['Chambre 5']));
    expect(noms(trameDesPieces('f2', null))).toEqual(expect.arrayContaining(['Salon / Séjour', 'Chambre']));
    expect(trameDesPieces('villa', 500).filter((r) => r.name.startsWith('Chambre'))).toHaveLength(PIECES_MAX - 1);
  });

  test('studio : pièce principale et salle d’eau / WC ; chambre : pas de cuisine', () => {
    expect(noms(trameDesPieces('studio', null))).toEqual(['Pièce principale', 'Cuisine', "Salle d'eau / WC"]);
    expect(noms(trameDesPieces('chambre', null))).toEqual(['Chambre', "Salle d'eau / WC"]);
  });

  test('meublé : mobilier dans les pièces de vie et la cuisine, jamais dans les WC', () => {
    const t = trameDesPieces('f2', null, true);
    expect(elements(t, 'Salon / Séjour')).toContain('mobilier');
    expect(elements(t, 'Cuisine')).toContain('mobilier');
    expect(elements(t, 'WC')).not.toContain('mobilier');
    expect(elements(t, 'Balcon / Terrasse')).not.toContain('mobilier');
  });

  test('local commercial / bureau : local principal, réserve, sanitaires', () => {
    expect(noms(trameDesPieces('local_commercial', null))).toEqual(['Local principal', 'Réserve', 'Sanitaires']);
    expect(noms(trameDesPieces('magasin', 3))).toEqual(['Local principal', 'Réserve', 'Sanitaires']);
    expect(noms(trameDesPieces('bureau', 3))).toEqual(['Local principal', 'Bureau 2', 'Bureau 3', 'Réserve', 'Sanitaires']);
    expect(elements(trameDesPieces('bureau', 1), 'Sanitaires')).toContain('sanitaires');
  });

  test('éléments par défaut d’une pièce ajoutée à la main, déduits de son nom', () => {
    expect(elementsParDefaut('Toilettes invités').map((e) => e.element)).toContain('sanitaires');
    expect(elementsParDefaut('Buanderie').map((e) => e.element)).toContain('plomberie');
    expect(elementsParDefaut('Bureau').map((e) => e.element)).not.toContain('plomberie');
  });

  test('normalisation des libellés', () => {
    expect(normaliser('Salon/Séjour')).toBe(normaliser('  salon - SEJOUR '));
    expect(normaliser(null)).toBe('');
  });
});

describe('Comparaison entrée / sortie (§ 52.3 étape 5)', () => {
  const item = (element, condition, extra = {}) => ({ id: `${element}-${condition}`, element, label: null, condition, comment: null, photos: [], ...extra });

  const entree = {
    rooms: [
      { name: 'Salon / Séjour', items: [item('murs', 'bon'), item('sols', 'usage'), item('fenetres', 'bon'), item('portes', 'bon')] },
      { name: 'Cuisine', items: [item('plomberie', 'bon'), item('autre', 'bon', { label: 'Évier' })] },
      { name: 'Cave', items: [item('murs', 'usage')] },
    ],
  };
  const sortie = {
    rooms: [
      // Nom saisi différemment : même pièce après normalisation.
      { name: 'salon - séjour', items: [
        item('murs', 'degrade', { comment: 'Trous de fixation', photos: [{ id: 'p1' }] }),
        item('sols', 'usage'),
        item('fenetres', 'hors_service', { comment: 'Vitre brisée' }),
        item('portes', 'bon'),
      ] },
      { name: 'Cuisine', items: [item('plomberie', 'bon'), item('autre', 'usage', { label: 'evier' }), item('mobilier', 'bon')] },
    ],
  };

  test('écarts aggravés uniquement, du plus grave au moins grave, avec commentaires et photos', () => {
    const r = comparerEtatsDesLieux(entree, sortie);
    expect(r.ecarts.map((e) => `${e.piece}:${e.element}`)).toEqual(['salon - séjour:fenetres', 'salon - séjour:murs', 'Cuisine:autre']);
    const fenetres = r.ecarts[0];
    expect(fenetres.aggravation).toBe(3);
    expect(fenetres.entree.condition).toBe('bon');
    expect(fenetres.sortie).toMatchObject({ condition: 'hors_service', comment: 'Vitre brisée', condition_libelle: 'Hors service' });
    expect(r.ecarts[1].sortie.photos).toEqual([{ id: 'p1' }]);
    expect(r.ecarts[2].label).toBe('evier');
  });

  test('éléments absents à la sortie et nouveaux éléments listés ; résumé cohérent', () => {
    const r = comparerEtatsDesLieux(entree, sortie);
    expect(r.absents).toHaveLength(1);
    expect(r.absents[0]).toMatchObject({ piece: 'Cave', element: 'murs' });
    expect(r.nouveaux).toHaveLength(1);
    expect(r.nouveaux[0]).toMatchObject({ piece: 'Cuisine', element: 'mobilier' });
    expect(r.resume).toEqual({
      elements_entree: 7, elements_sortie: 7, ecarts: 3, identiques: 3, ameliores: 0, absents: 1, nouveaux: 1,
    });
  });

  test('une amélioration n’est pas un écart ; éléments en double appariés dans l’ordre', () => {
    const a = { rooms: [{ name: 'Chambre', items: [item('portes', 'degrade'), item('portes', 'bon')] }] };
    const b = { rooms: [{ name: 'Chambre', items: [item('portes', 'bon'), item('portes', 'usage')] }] };
    const r = comparerEtatsDesLieux(a, b);
    expect(r.resume.ameliores).toBe(1);
    expect(r.ecarts).toHaveLength(1);
    expect(r.ecarts[0]).toMatchObject({ entree: { condition: 'bon' }, sortie: { condition: 'usage' } });
  });

  test('états des lieux vides : aucun écart', () => {
    expect(comparerEtatsDesLieux({ rooms: [] }, null).resume.ecarts).toBe(0);
  });
});
