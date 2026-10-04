'use strict';

/**
 * Outils partagés des tests du domaine paiements / quittances / échéances /
 * webhooks / abonnement (fichier sans `.test.js` : jamais exécuté seul).
 *
 * Seuls les appels SORTANTS vers PayDunya / Wave sont simulés (global.fetch,
 * setup/paydunyaSimule.js) ; base, imputation, quittances, relecture des
 * factures, signatures et webhooks sont réels.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const {
  api, bearer, sequelize, nouveauProprietaire, activerLocataire, bailActif,
} = require('../../../setup/helpers.js');

const {
  PAYDUNYA, PAYDUNYA_PLATEFORME, FACTURES, simulerFournisseurs, factureDe, ipn, corpsIpn, enFormulaire, empreinte,
  configurerPlateforme, retirerPlateforme,
} = require('../../../setup/paydunyaSimule.js');

const WAVE = { api_key: 'wave_api_key_test', webhook_secret: 'wave_webhook_secret' };
const UUID_ABSENT = '00000000-0000-4000-8000-000000000000';

/** Corps + en-tête d'un événement Wave signé (t=…,v1=…). */
function evenementWave(data, { type = 'checkout.session.completed', secret = WAVE.webhook_secret, t = Math.floor(Date.now() / 1000) } = {}) {
  const corps = JSON.stringify({ type, data });
  const signature = crypto.createHmac('sha256', secret).update(`${t}${corps}`).digest('hex');
  return { corps, entete: `t=${t},v1=${signature}` };
}

/** Échéances d'un bail (plus ancienne d'abord). */
async function echeancesDu(proprio, leaseId) {
  const res = await api().get(`/api/v1/echeances?lease_id=${leaseId}&tri=due_date&limit=100`).set(proprio.h);
  if (res.status !== 200) throw new Error(`Échéances : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.items;
}

/** Propriétaire + bail actif + PayDunya intégré configuré + compte locataire. */
async function preparerPaydunya(options = {}) {
  const p = await nouveauProprietaire();
  const bail = await bailActif(p, options);
  const moyen = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'paydunya', mode: 'integre', credentials: PAYDUNYA });
  if (moyen.status !== 200) throw new Error(`Moyen : ${moyen.status} ${JSON.stringify(moyen.body)}`);
  const loc = await activerLocataire(p, bail.tenant);
  const echeances = await echeancesDu(p, bail.lease.id);
  return { p, loc, ...bail, echeances, providerId: moyen.body.data.provider.id };
}

/** Propriétaire + bail actif + paiement direct avec preuve (Wave) + compte locataire. */
async function preparerPreuve(options = {}) {
  const p = await nouveauProprietaire();
  const bail = await bailActif(p, options);
  const moyen = await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'preuve', account_number: '771112233', label: 'Wave perso' });
  if (moyen.status !== 200) throw new Error(`Moyen : ${moyen.status} ${JSON.stringify(moyen.body)}`);
  const loc = await activerLocataire(p, bail.tenant);
  const echeances = await echeancesDu(p, bail.lease.id);
  return { p, loc, ...bail, echeances };
}

const initier = (loc, corps, cle = crypto.randomUUID()) => api().post('/api/v1/locataire/paiements').set(loc.h).set('Idempotency-Key', cle).send(corps);

let compteurPreuve = 0;
/** Identifiant de transaction mobile money unique. */
const idTransaction = (prefixe = 'WV') => `${prefixe}-${Date.now().toString(36)}-${(compteurPreuve += 1)}-${crypto.randomBytes(2).toString('hex')}`;

async function deposerPreuve(loc, scheduleId, montant, { wallet = 'wave' } = {}) {
  const res = await api().post('/api/v1/locataire/paiements/preuves').set(loc.h)
    .send({ rent_schedule_id: scheduleId, wallet, provider_transaction_id: idTransaction(), amount: montant });
  if (res.status !== 201) throw new Error(`Preuve : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.transaction;
}

// ── Jetons pour les contrôles d'authentification ────────────────────────────

async function versionJeton(userId) {
  const [[u]] = await sequelize.query('SELECT token_version FROM users WHERE id = :id', { replacements: { id: userId } });
  return u.token_version;
}

/** Jeton d'accès signé avec le vrai secret mais EXPIRÉ. */
async function jetonExpire(user) {
  return jwt.sign({ sub: user.id, role: user.role_code, tv: await versionJeton(user.id), typ: 'access', exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

/** Jeton d'accès valide pour la version courante (après une révocation, par ex.). */
async function jetonFrais(user) {
  return jwt.sign({ sub: user.id, role: user.role_code, tv: await versionJeton(user.id), typ: 'access' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

/** Jeton d'une version PÉRIMÉE (déconnexion de tous les appareils). */
async function jetonRevoque(user) {
  return jwt.sign({ sub: user.id, role: user.role_code, tv: (await versionJeton(user.id)) - 1, typ: 'access' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

/** Jeton signé avec un AUTRE secret. */
const jetonFalsifie = (user) => jwt.sign({ sub: user.id, tv: 0, typ: 'access' }, 'un-autre-secret-que-celui-du-serveur', { algorithm: 'HS256', expiresIn: '5m' });

/** Jeton de type « refresh » présenté comme jeton d'accès. */
const jetonMauvaisType = (user) => jwt.sign({ sub: user.id, tv: 0, typ: 'refresh' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });

const envoyer = (methode, url, entetes = {}, corps = {}) => {
  const r = api()[methode.toLowerCase()](url).set(entetes);
  return methode === 'GET' ? r : r.send(corps);
};

/**
 * Contrôles d'authentification d'une route : sans jeton, jeton falsifié,
 * expiré, de mauvais type, révoqué (version périmée) → 401 ; compte
 * désactivé → 403. `compte` est un compte JETABLE (il est désactivé à la fin).
 */
async function verifierAuthentification(methode, url, compte, corps = {}) {
  const cas = [
    ['sans jeton', {}, 401, 'TOKEN_MANQUANT'],
    ['schéma Basic', { Authorization: 'Basic abc' }, 401, 'TOKEN_MANQUANT'],
    ['jeton illisible', bearer('pas.un.jeton'), 401, 'TOKEN_INVALIDE'],
    ['jeton falsifié', bearer(jetonFalsifie(compte.user)), 401, 'TOKEN_INVALIDE'],
    ['jeton expiré', bearer(await jetonExpire(compte.user)), 401, 'TOKEN_EXPIRE'],
    ['jeton de rafraîchissement', bearer(jetonMauvaisType(compte.user)), 401, 'TOKEN_INVALIDE'],
    ['session révoquée', bearer(await jetonRevoque(compte.user)), 401, 'SESSION_REVOQUEE'],
  ];
  for (const [libelle, entetes, statut, code] of cas) {
    const res = await envoyer(methode, url, entetes, corps);
    if (res.status !== statut || res.body?.error?.code !== code) {
      throw new Error(`${methode} ${url} — ${libelle} : attendu ${statut} ${code}, reçu ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
}

/** Compte désactivé : 403 COMPTE_INACTIF sur chaque route (jeton pourtant valide). */
async function verifierCompteDesactive(routes, compte) {
  await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :id", { replacements: { id: compte.user.id } });
  const h = bearer(await jetonFrais(compte.user));
  for (const [methode, url, corps] of routes) {
    const res = await envoyer(methode, url, h, corps);
    if (res.status !== 403 || res.body.error.code !== 'COMPTE_INACTIF') {
      throw new Error(`${methode} ${url} — compte désactivé : reçu ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
}

/** Révocation réelle (« déconnecter tous les appareils ») : l'ancien jeton ne passe plus. */
async function revoquerSessions(userId) {
  await sequelize.query('UPDATE users SET token_version = token_version + 1 WHERE id = :id', { replacements: { id: userId } });
}

/**
 * Restreint le rôle d'un propriétaire à une liste de permissions (rôle créé
 * pour le test) : contrôle de la permission fine de chaque route.
 */
async function restreindrePermissions(proprio, permissions) {
  const code = `test_${crypto.randomBytes(4).toString('hex')}`;
  await sequelize.query('INSERT INTO roles (code, label, permissions) VALUES (:code, :code, ARRAY[:p]::text[])', { replacements: { code, p: permissions.length ? permissions : [''] } });
  await sequelize.query('UPDATE owner_members SET role_code = :code WHERE user_id = :u', { replacements: { code, u: proprio.user.id } });
  require('../../../../modules/auth/service/roles.service.js').invalider();
  return code;
}

/** Somme des mouvements de caisse non annulés d'un propriétaire, par sens. */
async function soldeCaisse(ownerId) {
  const [[r]] = await sequelize.query(
    `SELECT COALESCE(sum(amount) FILTER (WHERE direction = 'entree'), 0)::bigint AS entrees,
            COALESCE(sum(amount) FILTER (WHERE direction = 'sortie'), 0)::bigint AS sorties
       FROM cash_movements WHERE owner_id = :o AND cancelled_at IS NULL`,
    { replacements: { o: ownerId } }
  );
  return { entrees: Number(r.entrees), sorties: Number(r.sorties) };
}

async function ligne(sql, replacements = {}) {
  const [[r]] = await sequelize.query(sql, { replacements });
  return r;
}

async function lignes(sql, replacements = {}) {
  const [r] = await sequelize.query(sql, { replacements });
  return r;
}

module.exports = {
  PAYDUNYA, PAYDUNYA_PLATEFORME, FACTURES, WAVE, UUID_ABSENT, ipn, corpsIpn, enFormulaire, empreinte, factureDe, evenementWave,
  simulerFournisseurs, configurerPlateforme, retirerPlateforme, echeancesDu, preparerPaydunya, preparerPreuve,
  initier, idTransaction, deposerPreuve, jetonExpire, jetonFrais, jetonRevoque, jetonFalsifie, jetonMauvaisType,
  verifierAuthentification, verifierCompteDesactive, revoquerSessions, restreindrePermissions, soldeCaisse, ligne, lignes, envoyer,
};
