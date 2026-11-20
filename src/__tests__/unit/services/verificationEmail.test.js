'use strict';

/**
 * § 5 — vérification de l'adresse AVANT la création du compte. Modèles et
 * base simulés : aucune base. Ce qui est vérifié ici, c'est l'ORDRE et les
 * gardes — le code n'est jamais stocké en clair, chaque essai est compté même
 * quand le code est faux, le jeton ne vaut que pour son adresse, et il ne sert
 * qu'une fois.
 */

// L'étape est fermée par défaut, pour ne pas refuser l'inscription aux
// versions de l'application déjà installées. Ces tests décrivent l'étape une
// fois ouverte : on pose la variable avant que `security.js` ne la lise.
process.env.INSCRIPTION_VERIFICATION_EMAIL = 'true';

jest.mock('../../../models/index.js', () => ({
  User: { findOne: jest.fn(async () => null) },
  EmailVerification: { findOne: jest.fn(), create: jest.fn(async (v) => v), update: jest.fn(async () => [1]) },
}));
jest.mock('../../../config/db.js', () => ({
  transaction: jest.fn(async (cb) => cb({})),
  query: jest.fn(async () => [[{ attempts: 1 }]]),
  where: jest.fn((a, b) => ({ a, b })),
  fn: jest.fn((f, c) => `${f}(${c})`),
  col: jest.fn((c) => c),
}));
jest.mock('../../../modules/parametres/service/parametres.service.js', () => ({
  plateforme: jest.fn(async () => ({ duree_minutes: 15, tentatives_max: 5 })),
}));
jest.mock('../../../infrastructure/email.service.js', () => ({
  envoyerCodeInscription: jest.fn(async () => ({ envoye: true })),
}));

const { User, EmailVerification } = require('../../../models/index.js');
const sequelize = require('../../../config/db.js');
const email = require('../../../infrastructure/email.service.js');
const service = require('../../../modules/auth/service/verificationEmail.service.js');

const ADRESSE = 'Awa.Diop@Example.sn';
const erreur = async (promesse) => promesse.then(() => null, (e) => ({ statut: e.statusCode, code: e.code }));

/** Dernier code réellement envoyé par e-mail. */
const codeEnvoye = () => email.envoyerCodeInscription.mock.calls.at(-1)[0].code;
/** Dernière ligne écrite en base. */
const ligneCreee = () => EmailVerification.create.mock.calls.at(-1)[0];

/** La demande en cours que `verifierCode` va trouver. */
function demandeEnCours(ligne) {
  EmailVerification.findOne.mockResolvedValue({
    id: 'v-1', ...ligne, update: jest.fn(async () => {}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  User.findOne.mockResolvedValue(null);
  sequelize.transaction.mockImplementation(async (cb) => cb({}));
  sequelize.query.mockResolvedValue([[{ attempts: 1 }]]);
});

describe('demande du code', () => {
  test('une adresse déjà utilisée est refusée avant tout envoi', async () => {
    User.findOne.mockResolvedValue({ id: 'u-1' });
    expect(await erreur(service.demanderCode({ email: ADRESSE })))
      .toEqual({ statut: 409, code: 'COMPTE_EXISTANT' });
    expect(email.envoyerCodeInscription).not.toHaveBeenCalled();
    expect(EmailVerification.create).not.toHaveBeenCalled();
  });

  test('le code fait 6 chiffres et n’est jamais écrit en clair', async () => {
    await service.demanderCode({ email: ADRESSE, prenom: 'Awa' });
    const code = codeEnvoye();
    expect(code).toMatch(/^[0-9]{6}$/);
    const ligne = ligneCreee();
    expect(ligne.code_hash).toHaveLength(64);
    expect(ligne.code_hash).not.toContain(code);
    // L'adresse est rangée en minuscules : la retrouver ne dépend pas de la casse.
    expect(ligne.email).toBe(ADRESSE.toLowerCase());
  });

  test('les demandes précédentes pour cette adresse sont closes', async () => {
    await service.demanderCode({ email: ADRESSE });
    expect(EmailVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({ used_at: expect.any(Date) }),
      expect.objectContaining({ where: { email: ADRESSE.toLowerCase(), used_at: null } })
    );
  });

  test('un envoi d’e-mail en panne ne perd pas la demande', async () => {
    email.envoyerCodeInscription.mockRejectedValueOnce(new Error('fournisseur injoignable'));
    await expect(service.demanderCode({ email: ADRESSE })).resolves.toEqual({ minutes: 15 });
    expect(EmailVerification.create).toHaveBeenCalled();
  });
});

describe('vérification du code', () => {
  /** Demande une adresse et renvoie le code envoyé, prêt à être vérifié. */
  async function demanderPuisPreparer() {
    await service.demanderCode({ email: ADRESSE });
    const { code_hash: empreinte } = ligneCreee();
    demandeEnCours({ email: ADRESSE.toLowerCase(), code_hash: empreinte, attempts: 0 });
    return codeEnvoye();
  }

  test('sans demande en cours, le code est refusé', async () => {
    EmailVerification.findOne.mockResolvedValue(null);
    expect(await erreur(service.verifierCode({ email: ADRESSE, code: '123456' })))
      .toEqual({ statut: 400, code: 'CODE_INVALIDE' });
  });

  test('un code faux est refusé ET compte comme un essai', async () => {
    const bon = await demanderPuisPreparer();
    const faux = bon === '000000' ? '111111' : '000000';
    expect(await erreur(service.verifierCode({ email: ADRESSE, code: faux })))
      .toEqual({ statut: 400, code: 'CODE_INVALIDE' });
    // L'essai est compté AVANT la comparaison : sinon, un code faux serait gratuit.
    expect(sequelize.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE email_verifications SET attempts = attempts + 1'),
      expect.anything()
    );
  });

  test('le plafond d’essais atteint ferme le code', async () => {
    await demanderPuisPreparer();
    sequelize.query.mockResolvedValue([[]]); // la mise à jour conditionnelle ne touche rien
    expect(await erreur(service.verifierCode({ email: ADRESSE, code: '123456' })))
      .toEqual({ statut: 400, code: 'CODE_EPUISE' });
  });

  test('le bon code rend un jeton, et la casse de l’adresse est indifférente', async () => {
    const code = await demanderPuisPreparer();
    const { jeton } = await service.verifierCode({ email: ADRESSE.toUpperCase(), code });
    expect(typeof jeton).toBe('string');
  });
});

describe('consommation du jeton à l’inscription', () => {
  async function jetonValide() {
    await service.demanderCode({ email: ADRESSE });
    const code = codeEnvoye();
    demandeEnCours({ email: ADRESSE.toLowerCase(), code_hash: ligneCreee().code_hash, attempts: 0 });
    const { jeton } = await service.verifierCode({ email: ADRESSE, code });
    return jeton;
  }

  test('sans jeton, l’inscription est refusée', async () => {
    expect(await erreur(service.consommerJeton({ email: ADRESSE, jeton: null })))
      .toEqual({ statut: 400, code: 'EMAIL_NON_VERIFIE' });
  });

  test('un jeton inventé est refusé', async () => {
    expect(await erreur(service.consommerJeton({ email: ADRESSE, jeton: 'pas.un.jeton' })))
      .toEqual({ statut: 400, code: 'EMAIL_NON_VERIFIE' });
  });

  test('un jeton ne vaut que pour l’adresse qu’il a vérifiée', async () => {
    const jeton = await jetonValide();
    expect(await erreur(service.consommerJeton({ email: 'autre@example.sn', jeton })))
      .toEqual({ statut: 400, code: 'EMAIL_NON_VERIFIE' });
  });

  test('un jeton ne crée qu’un seul compte', async () => {
    const jeton = await jetonValide();
    sequelize.query.mockResolvedValueOnce([[{ id: 'v-1' }]]);
    await expect(service.consommerJeton({ email: ADRESSE, jeton })).resolves.toBeUndefined();
    // Deuxième passage : la ligne est déjà consommée, la mise à jour ne touche rien.
    sequelize.query.mockResolvedValueOnce([[]]);
    expect(await erreur(service.consommerJeton({ email: ADRESSE, jeton })))
      .toEqual({ statut: 400, code: 'EMAIL_NON_VERIFIE' });
  });
});

// Une vérification que l'on éteint par mégarde ne se voit pas : l'inscription
// continue de marcher, simplement plus personne ne contrôle l'adresse. Seul
// `false`, écrit exactement ainsi, doit ouvrir la porte — ni une variable
// absente, ni une faute de frappe.
describe('coupe-circuit : « false » et rien d’autre', () => {
  /** Le service tel qu'il se charge avec cette valeur de variable. */
  const avecVariable = (valeur) => {
    const precedente = process.env.INSCRIPTION_VERIFICATION_EMAIL;
    let service;
    jest.isolateModules(() => {
      if (valeur === undefined) delete process.env.INSCRIPTION_VERIFICATION_EMAIL;
      else process.env.INSCRIPTION_VERIFICATION_EMAIL = valeur;
      service = require('../../../modules/auth/service/verificationEmail.service.js');
    });
    process.env.INSCRIPTION_VERIFICATION_EMAIL = precedente;
    return service;
  };

  test('« false » : l’inscription repasse en direct, sans jeton', async () => {
    await expect(avecVariable('false').consommerJeton({ email: ADRESSE, jeton: null }))
      .resolves.toBeUndefined();
  });

  for (const valeur of [undefined, 'true', 'False', '0', 'non']) {
    test(`variable ${valeur ?? 'absente'} : la vérification reste exigée`, async () => {
      expect(await erreur(avecVariable(valeur).consommerJeton({ email: ADRESSE, jeton: null })))
        .toEqual({ statut: 400, code: 'EMAIL_NON_VERIFIE' });
    });
  }
});
