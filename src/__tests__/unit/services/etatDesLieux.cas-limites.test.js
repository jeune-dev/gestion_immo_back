'use strict';

const {
  trameDesPieces, elementsParDefaut, naturePiece, normaliser, PIECES_MAX,
} = require('../../../modules/etatDesLieux/service/trame.service.js');
const { comparerEtatsDesLieux, cle } = require('../../../modules/etatDesLieux/service/comparaison.service.js');

/**
 * Cas limites de la trame de pièces (§ 52.3 étape 1) et de la comparaison
 * entrée / sortie (§ 52.3 étape 5) — complète etatDesLieux.comparaison.test.js.
 */

describe('Trame : cas limites', () => {
  test.each([0, -3, 2.5, null, undefined, 'trois'])('rooms_count invalide (%p) : nombre de pièces du type utilisé', (n) => {
    expect(trameDesPieces('f3', n).map((r) => r.name)).toEqual(trameDesPieces('f3', null).map((r) => r.name));
  });

  test('rooms_count aberrant plafonné à PIECES_MAX (aucune trame de centaines de lignes)', () => {
    const trame = trameDesPieces('villa', 500);
    const chambres = trame.filter((r) => r.name.startsWith('Chambre'));
    expect(chambres).toHaveLength(PIECES_MAX - 1);
  });

  test('type inconnu : repli sur « autre » (2 pièces principales)', () => {
    expect(trameDesPieces('chateau', null).map((r) => r.name)).toEqual(['Salon / Séjour', 'Chambre', 'Cuisine', 'Salle de bain', 'WC', 'Balcon / Terrasse']);
  });

  test('positions consécutives des pièces et des éléments', () => {
    for (const room of trameDesPieces('f4', null, true)) {
      expect(room.items.map((i) => i.position)).toEqual(room.items.map((_, i) => i));
    }
    expect(trameDesPieces('f4', null).map((r) => r.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test.each([
    ['SALLE D’EAU', 'sanitaire'], ['Toilettes invités', 'sanitaire'], ['Douche extérieure', 'sanitaire'], ['wc', 'sanitaire'],
    ['Kitchenette', 'eau'], ['Buanderie', 'eau'], ['Garage', 'exterieur'], ['Jardin', 'exterieur'], ['Débarras', 'reserve'],
    ['Cave à vin', 'reserve'], ['Bureau', 'principale'], ['', 'principale'], [null, 'principale'], ['Swc', 'principale'],
  ])('nature de « %s » : %s', (nom, nature) => {
    expect(naturePiece(nom)).toBe(nature);
  });

  test('meublé : pas de mobilier dans une pièce extérieure ou une réserve', () => {
    expect(elementsParDefaut('Terrasse', true).map((e) => e.element)).not.toContain('mobilier');
    expect(elementsParDefaut('Réserve', true).map((e) => e.element)).not.toContain('mobilier');
    expect(elementsParDefaut('Cuisine', true).map((e) => e.element)).toContain('mobilier');
  });

  test('normalisation : accents, casse, ponctuation, espaces multiples, valeurs vides', () => {
    expect(normaliser('  Salon/Séjour  ')).toBe(normaliser('salon - SEJOUR'));
    expect(normaliser('Pièce   n°2')).toBe('piece n 2');
    expect(normaliser(null)).toBe('');
    expect(normaliser(undefined)).toBe('');
  });
});

describe('Comparaison : cas limites', () => {
  const edl = (...rooms) => ({ rooms });
  const room = (name, ...items) => ({ name, items });
  const item = (element, condition, extra = {}) => ({ element, condition, label: null, ...extra });

  test('états des lieux absents ou mal formés : aucun écart, pas d’exception', () => {
    for (const [a, b] of [[null, null], [undefined, {}], [{ rooms: null }, { rooms: [] }], [edl(room('Salon')), edl(room('Salon', ...[]))]]) {
      const r = comparerEtatsDesLieux(a, b);
      expect(r.ecarts).toEqual([]);
      expect(r.resume).toMatchObject({ ecarts: 0, absents: 0, nouveaux: 0 });
    }
  });

  test('libellé null, vide ou absent : même élément ; nom de pièce apparié malgré accents et ponctuation', () => {
    const entree = edl(room('Salon/Séjour', item('murs', 'bon', { label: null })));
    const sortie = edl(room('salon - sejour', item('murs', 'degrade', { label: '' })));
    const r = comparerEtatsDesLieux(entree, sortie);
    expect(r.ecarts).toHaveLength(1);
    expect(r.ecarts[0]).toMatchObject({ piece: 'salon - sejour', element: 'murs', aggravation: 2, entree: { condition: 'bon' }, sortie: { condition: 'degrade' } });
    expect(cle('Salon/Séjour', 'murs', null)).toBe(cle('SALON SÉJOUR', 'murs', ''));
  });

  test('état inconnu traité comme « bon » (gravité 0) ; libellé d’état repris tel quel', () => {
    const r = comparerEtatsDesLieux(edl(room('A', item('sols', 'inconnu'))), edl(room('A', item('sols', 'usage'))));
    expect(r.ecarts[0]).toMatchObject({ aggravation: 1, entree: { condition: 'inconnu', condition_libelle: 'inconnu' } });
  });

  test('bon → hors service : aggravation maximale (3), classée en premier', () => {
    const r = comparerEtatsDesLieux(
      edl(room('A', item('sols', 'bon'), item('murs', 'bon'))),
      edl(room('A', item('sols', 'usage'), item('murs', 'hors_service')))
    );
    expect(r.ecarts.map((e) => [e.element, e.aggravation])).toEqual([['murs', 3], ['sols', 1]]);
  });

  test('trois éléments identiques sans libellé : appariés dans l’ordre, le troisième absent à la sortie', () => {
    const r = comparerEtatsDesLieux(
      edl(room('Chambre', item('portes', 'bon'), item('portes', 'bon'), item('portes', 'usage'))),
      edl(room('Chambre', item('portes', 'bon'), item('portes', 'degrade')))
    );
    expect(r.ecarts).toHaveLength(1);
    expect(r.absents).toHaveLength(1);
    expect(r.resume).toMatchObject({ elements_entree: 3, elements_sortie: 2, identiques: 1, ecarts: 1, absents: 1 });
  });

  test('photos et commentaires des deux côtés conservés dans l’écart (justificatif de retenue § 52.3 étape 6)', () => {
    const photos = [{ id: 'p1' }];
    const r = comparerEtatsDesLieux(
      edl(room('A', item('sols', 'bon', { id: 'e1', comment: 'Neuf', photos: [] }))),
      edl(room('A', item('sols', 'degrade', { id: 's1', comment: 'Cassé', photos })))
    );
    expect(r.ecarts[0].entree).toMatchObject({ item_id: 'e1', comment: 'Neuf', photos: [] });
    expect(r.ecarts[0].sortie).toMatchObject({ item_id: 's1', comment: 'Cassé', photos });
  });

  test('une pièce renommée : ses éléments sont absents à l’entrée et nouveaux à la sortie', () => {
    const r = comparerEtatsDesLieux(edl(room('Chambre 1', item('murs', 'bon'))), edl(room('Chambre parentale', item('murs', 'bon'))));
    expect(r.resume).toMatchObject({ absents: 1, nouveaux: 1, identiques: 0 });
  });
});
