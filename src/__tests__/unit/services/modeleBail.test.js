'use strict';

const {
  VARIABLES, variablesUtilisees, variablesInconnues, rendre,
} = require('../../../modules/bail/service/modeleBail.service.js');
const { ValidationError } = require('../../../errors/AppError.js');
const seederModeles = require('../../../seeders/20260928000105-modeles-bail.js');

afterAll(() => require('../../../config/db.js').close());

/**
 * Modèle de bail (§ 53.4) : champs variables remplis depuis la base, jamais
 * laissés en clair, jamais interprétés deux fois.
 */

describe('variablesUtilisees / variablesInconnues', () => {
  test('extrait les variables, sans doublon, espaces tolérés dans les accolades', () => {
    expect(variablesUtilisees('{{bail.loyer}} puis {{ bail.loyer }} et {{locataire.nom}}, {{annexes}}')).toEqual(['bail.loyer', 'locataire.nom', 'annexes']);
  });

  test('ignore ce qui n’est pas une variable (accolades simples, majuscules, chemins profonds)', () => {
    expect(variablesUtilisees('{bail.loyer} {{BAIL.LOYER}} {{a.b.c}} {{}} {{ 1abc }}')).toEqual([]);
  });

  test('texte vide ou non textuel', () => {
    expect(variablesUtilisees('')).toEqual([]);
    expect(variablesUtilisees(null)).toEqual([]);
    expect(variablesUtilisees(42)).toEqual([]);
  });

  test('inconnues : seules celles hors catalogue', () => {
    expect(variablesInconnues('{{bail.loyer}} {{bail.pourboire}} {{pirate}}')).toEqual(['bail.pourboire', 'pirate']);
    expect(variablesInconnues(VARIABLES.map((v) => `{{${v}}}`).join(' '))).toEqual([]);
  });

  test('les trois modèles livrés (habitation, professionnel, meublé) n’utilisent que des variables du catalogue', async () => {
    const corps = [];
    await seederModeles.up({ sequelize: { query: async (_sql, { replacements }) => corps.push(replacements) } });
    expect(corps.map((c) => c.type).sort()).toEqual(['habitation', 'meuble', 'professionnel']);
    for (const c of corps) {
      expect(variablesInconnues(c.corps)).toEqual([]);
      expect(variablesUtilisees(c.corps).length).toBeGreaterThan(10);
    }
  });
});

describe('rendre', () => {
  test('remplace chaque occurrence ; valeur absente, null ou undefined → chaîne vide', () => {
    const texte = 'Loyer : {{bail.loyer}} ({{ bail.loyer }}). Fin : {{bail.date_fin}}. Email : {{locataire.email}}. Pièces : {{bien.pieces}}.';
    expect(rendre(texte, { 'bail.loyer': '350 000 FCFA', 'bail.date_fin': null, 'bien.pieces': 0 }))
      .toBe('Loyer : 350 000 FCFA (350 000 FCFA). Fin : . Email : . Pièces : 0.');
  });

  test('une valeur contenant elle-même « {{…}} » n’est jamais réinterprétée (pas d’injection de variable)', () => {
    const rendu = rendre('Locataire : {{locataire.nom}} — loyer {{bail.loyer}}', { 'locataire.nom': '{{bail.loyer}}', 'bail.loyer': '1 FCFA' });
    expect(rendu).toBe('Locataire : {{bail.loyer}} — loyer 1 FCFA');
  });

  test('variable inconnue → ValidationError MODELE_INVALIDE listant les variables, rien n’est rendu', () => {
    let erreur;
    try {
      rendre('{{bail.loyer}} {{bail.inconnue}} {{autre}}', { 'bail.loyer': 'x' });
    } catch (e) {
      erreur = e;
    }
    expect(erreur).toBeInstanceOf(ValidationError);
    expect(erreur.code).toBe('MODELE_INVALIDE');
    expect(erreur.details).toEqual(['{{bail.inconnue}}', '{{autre}}']);
  });

  test('texte sans variable rendu tel quel ; caractères spéciaux conservés', () => {
    const texte = 'Article 1 — « 100 % » $& $1 \\n';
    expect(rendre(texte, {})).toBe(texte);
    expect(rendre('{{bail.reference}}', { 'bail.reference': '$& $1 $$' })).toBe('$& $1 $$');
  });
});
