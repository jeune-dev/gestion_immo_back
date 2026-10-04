'use strict';

/**
 * Outils partagés des tests de SÉCURITÉ des modules bail, caution, document,
 * état des lieux, messagerie et notification (§ 32, § 43).
 *
 * - `jetonsDegrades` : un jeu de jetons qui ne doivent JAMAIS ouvrir une route
 *   (absent, mal formé, expiré, de rafraîchissement, révoqué par
 *   `token_version`, compte désactivé) avec le statut attendu ;
 * - `verifierMatrice` : rejoue chaque route avec chaque jeton et renvoie la
 *   liste des écarts (lisible dans l'échec du test).
 *
 * Fichier sans `.test.js` : chargé par les tests, jamais exécuté seul.
 */
const jwt = require('jsonwebtoken');
const { jwtConfig } = require('../../../../config/security.js');
const {
  api, nouveauProprietaire, proprietaireEtLocataire, sequelize,
} = require('../../../setup/helpers.js');
const roles = require('../../../../modules/auth/service/roles.service.js');

const UUID_INCONNU = '6f1c1d52-8d4b-4c8e-9a51-2f3c2b0d9e11';

/** Jeton d'accès signé avec le vrai secret mais EXPIRÉ depuis une minute. */
function jetonExpire(user, tokenVersion = 0) {
  return jwt.sign(
    {
      sub: user.id, role: user.role_code, tv: tokenVersion, typ: 'access', exp: Math.floor(Date.now() / 1000) - 60,
    },
    jwtConfig.secret,
    { algorithm: jwtConfig.algorithme }
  );
}

/**
 * Jetons dégradés pour un espace : `proprietaire` ou `locataire`.
 * Deux comptes dédiés sont créés : l'un révoqué (token_version incrémentée),
 * l'autre désactivé — ils ne servent qu'à ces vérifications.
 * @returns {Promise<Array<{ cas: string, h: object, statut: number }>>}
 */
async function jetonsDegrades(espace = 'proprietaire') {
  const compte = async () => (espace === 'locataire' ? (await proprietaireEtLocataire()).locataire : nouveauProprietaire());
  const [actif, revoque, inactif] = await Promise.all([compte(), compte(), compte()]);
  const [[{ token_version: tv }]] = await sequelize.query('SELECT token_version FROM users WHERE id = :id', { replacements: { id: actif.user.id } });
  await sequelize.query('UPDATE users SET token_version = token_version + 1 WHERE id = :id', { replacements: { id: revoque.user.id } });
  await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :id", { replacements: { id: inactif.user.id } });
  const rafraichissement = actif.refreshToken
    || jwt.sign({ sub: actif.user.id, typ: 'refresh' }, process.env.JWT_REFRESH_SECRET, { algorithm: jwtConfig.algorithme, expiresIn: '1h' });
  return [
    { cas: 'sans jeton', h: {}, statut: 401 },
    { cas: 'jeton mal formé', h: { Authorization: 'Bearer pas.un.jeton' }, statut: 401 },
    { cas: 'en-tête sans Bearer', h: { Authorization: actif.token }, statut: 401 },
    { cas: 'jeton expiré', h: { Authorization: `Bearer ${jetonExpire(actif.user, tv)}` }, statut: 401 },
    { cas: 'jeton signé par un autre secret', h: { Authorization: `Bearer ${jwt.sign({ sub: actif.user.id, typ: 'access', tv }, 'secret-pirate')}` }, statut: 401 },
    { cas: 'jeton de rafraîchissement', h: { Authorization: `Bearer ${rafraichissement}` }, statut: 401 },
    { cas: 'jeton révoqué (token_version)', h: revoque.h, statut: 401 },
    { cas: 'compte désactivé', h: inactif.h, statut: 403 },
  ];
}

/**
 * @param {Array<[string, string]>} routes  [méthode, url]
 * @param {Array<{ cas: string, h: object, statut: number }>} jetons
 * @returns {Promise<string[]>} écarts constatés (vide = conforme)
 */
async function verifierMatrice(routes, jetons) {
  const ecarts = [];
  for (const [methode, url] of routes) {
    for (const { cas, h, statut } of jetons) {
      const res = await api()[methode](url).set(h).send({});
      if (res.status !== statut) ecarts.push(`${methode.toUpperCase()} ${url} [${cas}] → ${res.status} (attendu ${statut})`);
    }
  }
  return ecarts;
}

/**
 * Rejoue des requêtes et renvoie celles dont le statut diffère de l'attendu.
 * @param {Array<[string, string, object|undefined, number]>} cas [méthode, url, corps, statut]
 * @param {object} h en-têtes
 */
async function verifierStatuts(cas, h) {
  const ecarts = [];
  for (const [methode, url, corps, statut] of cas) {
    const res = await api()[methode](url).set(h).send(corps ?? {});
    if (res.status !== statut) ecarts.push(`${methode.toUpperCase()} ${url} ${JSON.stringify(corps ?? {})} → ${res.status} (attendu ${statut}) ${res.body?.error?.code || ''}`);
  }
  return ecarts;
}

/**
 * Propriétaire dont le rôle dans l'espace est remplacé par un rôle SANS
 * aucune permission (§ 32 RBAC) : toute route à permission répond 403.
 */
async function proprietaireSansPermission() {
  const p = await nouveauProprietaire();
  const code = `test_sans_droit_${p.user.id.slice(0, 8)}`;
  await sequelize.query("INSERT INTO roles (code, label, permissions) VALUES (:code, 'Test sans droit', '{}')", { replacements: { code } });
  await sequelize.query('UPDATE owner_members SET role_code = :code WHERE user_id = :u', { replacements: { code, u: p.user.id } });
  roles.invalider();
  return p;
}

module.exports = {
  UUID_INCONNU, jetonExpire, jetonsDegrades, verifierMatrice, verifierStatuts, proprietaireSansPermission,
};
