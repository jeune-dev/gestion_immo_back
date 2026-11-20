'use strict';

// Étape ouverte pour CE fichier, avant tout `require` qui charge
// l'application : `security.js` lit la variable une fois, au chargement.
// setup/env.js l'éteint pour tous les autres fichiers, qui créent un
// propriétaire sans avoir à traverser l'envoi d'un code.
process.env.INSCRIPTION_VERIFICATION_EMAIL = 'true';

const {
  api, MOT_DE_PASSE, telephoneUnique, emailUnique, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');
const email = require('../../../../infrastructure/email.service.js');

/**
 * § 5 — vérification de l'adresse AVANT la création du compte : un code à
 * 6 chiffres part à l'adresse saisie, le client rapporte un jeton, et
 * l'inscription le présente.
 *
 * L'ordre est le sujet : une inscription abandonnée ne doit rien laisser
 * derrière elle, et un compte créé doit porter une adresse qui fonctionne.
 * Le code est intercepté à l'envoi de l'e-mail, seul endroit où il existe en
 * clair — en base il n'y a qu'une empreinte.
 */

const CODE = '/api/v1/auth/inscription/code';
const VERIF = '/api/v1/auth/inscription/verifier-code';
const INSCRIPTION = '/api/v1/auth/inscription';

let envoi;
beforeEach(() => {
  envoi = jest.spyOn(email, 'envoyerCodeInscription').mockResolvedValue({ envoye: true });
});
afterEach(() => envoi.mockRestore());
afterAll(fermer);

/** Demande un code et rend celui qui est réellement parti par e-mail. */
async function demanderCode(adresse, prenom) {
  envoi.mockClear();
  const res = await api().post(CODE).send({ email: adresse, ...(prenom ? { first_name: prenom } : {}) });
  expect(res.status).toBe(200);
  return envoi.mock.calls.at(-1)?.[0]?.code;
}

/** Adresse vérifiée de bout en bout ; rend le jeton. */
async function jetonPour(adresse) {
  const code = await demanderCode(adresse);
  const verif = await api().post(VERIF).send({ email: adresse, code });
  expect(verif.status).toBe(200);
  return verif.body.data.email_token;
}

const inscrire = (adresse, jeton) => api().post(INSCRIPTION).send({
  first_name: 'Awa',
  last_name: 'Diop',
  phone: telephoneUnique(),
  email: adresse,
  password: MOT_DE_PASSE,
  password_confirmation: MOT_DE_PASSE,
  ...(jeton === undefined ? {} : { email_token: jeton }),
});

describe('Inscription : vérification de l’adresse', () => {
  test('parcours complet : code envoyé, adresse vérifiée, compte créé avec le jeton', async () => {
    const adresse = emailUnique('inscription');
    const code = await demanderCode(adresse, 'Awa');

    expect(code).toMatch(/^[0-9]{6}$/);
    // Le prénom saisi à l'étape 1 sert à la salutation de l'e-mail.
    expect(envoi.mock.calls[0][0]).toMatchObject({ email: adresse, prenom: 'Awa' });

    // En base, une empreinte — jamais le code.
    const [[demande]] = await sequelize.query(
      'SELECT code_hash, used_at FROM email_verifications WHERE email = :e',
      { replacements: { e: adresse.toLowerCase() } }
    );
    expect(demande.code_hash).not.toContain(code);
    expect(demande.used_at).toBeNull();

    // Étape 2 : le code est accepté avec un espace au milieu.
    const verif = await api().post(VERIF).send({ email: adresse, code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(verif.status).toBe(200);

    // Aucun compte tant que l'inscription n'est pas envoyée.
    expect(await compter('users', 'lower(email) = :e', { e: adresse.toLowerCase() })).toBe(0);

    const creation = await inscrire(adresse, verif.body.data.email_token);
    expect(creation.status).toBe(201);
    expect(creation.body.data.user.email).toBe(adresse.toLowerCase());
  });

  test('sans jeton, l’inscription est refusée et aucun compte n’est créé', async () => {
    const adresse = emailUnique('inscription');
    const res = await inscrire(adresse);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMAIL_NON_VERIFIE');
    expect(await compter('users', 'lower(email) = :e', { e: adresse.toLowerCase() })).toBe(0);
  });

  test('un jeton inventé, ou celui d’une autre adresse, est refusé', async () => {
    const verifiee = emailUnique('inscription');
    const jeton = await jetonPour(verifiee);
    const autre = emailUnique('inscription');

    expect((await inscrire(autre, 'pas.un.jeton')).body.code).toBe('EMAIL_NON_VERIFIE');
    // Le jeton vaut pour l'adresse qu'il a vérifiée, pas pour une autre.
    expect((await inscrire(autre, jeton)).body.code).toBe('EMAIL_NON_VERIFIE');
    expect(await compter('users', 'lower(email) = :e', { e: autre.toLowerCase() })).toBe(0);
  });

  test('un jeton ne crée qu’un seul compte', async () => {
    const adresse = emailUnique('inscription');
    const jeton = await jetonPour(adresse);
    expect((await inscrire(adresse, jeton)).status).toBe(201);
    // Deuxième passage : l'adresse est prise, et le jeton est consommé.
    const rejeu = await inscrire(adresse, jeton);
    expect([400, 409]).toContain(rejeu.status);
  });

  test('un code faux est refusé, et chaque essai est compté', async () => {
    const adresse = emailUnique('inscription');
    const code = await demanderCode(adresse);
    const faux = code === '000000' ? '111111' : '000000';

    const refus = await api().post(VERIF).send({ email: adresse, code: faux });
    expect(refus.status).toBe(400);
    expect(refus.body.code).toBe('CODE_INVALIDE');

    const [[ligne]] = await sequelize.query(
      'SELECT attempts FROM email_verifications WHERE email = :e',
      { replacements: { e: adresse.toLowerCase() } }
    );
    expect(Number(ligne.attempts)).toBe(1);
  });

  test('un code non conforme n’atteint pas le service', async () => {
    const adresse = emailUnique('inscription');
    await demanderCode(adresse);
    expect((await api().post(VERIF).send({ email: adresse, code: '12345' })).status).toBe(422);
    expect((await api().post(VERIF).send({ email: adresse, code: 'abcdef' })).status).toBe(422);
  });

  test('une adresse déjà prise n’ouvre pas de vérification', async () => {
    const adresse = emailUnique('inscription');
    expect((await inscrire(adresse, await jetonPour(adresse))).status).toBe(201);

    envoi.mockClear();
    const res = await api().post(CODE).send({ email: adresse });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COMPTE_EXISTANT');
    // Rien n'est parti : l'adresse d'un tiers ne sert pas de sonnette.
    expect(envoi).not.toHaveBeenCalled();
  });

  test('une nouvelle demande annule la précédente', async () => {
    const adresse = emailUnique('inscription');
    const premier = await demanderCode(adresse);
    const second = await demanderCode(adresse);
    expect(second).not.toBe(premier);

    expect((await api().post(VERIF).send({ email: adresse, code: premier })).status).toBe(400);
    expect((await api().post(VERIF).send({ email: adresse, code: second })).status).toBe(200);
  });
});
