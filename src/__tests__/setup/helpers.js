'use strict';

/**
 * Aides des tests d'intégration : un propriétaire, un super admin, du
 * patrimoine et des baux créés PAR L'API (mêmes chemins que le mobile).
 */
const crypto = require('crypto');
const request = require('supertest');
const app = require('../../app.js');
const sequelize = require('../../config/db.js');
const bcrypt = require('../../utils/motDePasse.js');
const totp = require('../../utils/totp.js');
const { encrypt } = require('../../utils/cryptoField.js');

/**
 * Routes de mouvement d'argent qui EXIGENT une Idempotency-Key (comme le
 * client mobile, `api()` en pose une neuve à chaque appel ; un test qui fixe
 * la sienne la remplace). L'obligation elle-même est vérifiée avec une requête
 * brute (`apiBrute()`), sans clé.
 */
const ROUTES_IDEMPOTENCE_OBLIGATOIRE = /^\/api\/v1\/(paiements\/(especes|[^/]+\/rembourser)|cautions\/[^/]+\/(versements|retenues|restitutions))$/;
const api = () => {
  const agent = request(app);
  const post = agent.post.bind(agent);
  agent.post = (url) => {
    const test = post(url);
    return ROUTES_IDEMPOTENCE_OBLIGATOIRE.test(String(url).split('?')[0]) ? test.set('Idempotency-Key', crypto.randomUUID()) : test;
  };
  return agent;
};
const apiBrute = () => request(app);
const MOT_DE_PASSE = 'MotDePasse1';

/**
 * Téléphone sénégalais UNIQUE dans la base du worker.
 *
 * Un tirage aléatoire ne suffit pas : Jest recharge ce module pour chaque
 * fichier (un registre en mémoire repart de zéro), alors que la base du worker
 * cumule les comptes de TOUS les fichiers — ~2 500 numéros sur 10 millions
 * donnaient une collision (409 « numéro déjà utilisé ») dans ~30 % des
 * exécutions complètes. Compteur séquentiel persistant, propre à la base
 * (une base = un seul processus Jest, jamais d'accès concurrent au fichier).
 */
const fs = require('fs');
const path = require('path');

const FICHIER_COMPTEUR = path.resolve(__dirname, '..', '..', '..', 'tmp', `telephones-${process.env.DB_NAME || 'unit'}.txt`);
function telephoneUnique() {
  fs.mkdirSync(path.dirname(FICHIER_COMPTEUR), { recursive: true });
  let n;
  try {
    n = Number(fs.readFileSync(FICHIER_COMPTEUR, 'utf8'));
  } catch {
    n = NaN;
  }
  // Départ aléatoire à la première utilisation, puis +1 à chaque numéro.
  n = Number.isInteger(n) ? (n + 1) % 10_000_000 : crypto.randomInt(0, 10_000_000);
  fs.writeFileSync(FICHIER_COMPTEUR, String(n));
  return `+22177${String(n).padStart(7, '0')}`;
}
const emailUnique = (prefixe = 'user') => `${prefixe}.${crypto.randomBytes(5).toString('hex')}@test.sn`;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/** Inscrit un propriétaire et renvoie sa session. */
async function nouveauProprietaire(surcharges = {}) {
  const corps = {
    first_name: 'Balla', last_name: 'Diop', phone: telephoneUnique(), email: emailUnique('proprio'),
    password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE, ...surcharges,
  };
  const res = await api().post('/api/v1/auth/inscription').send(corps);
  if (res.status !== 201) throw new Error(`Inscription impossible : ${res.status} ${JSON.stringify(res.body)}`);
  const [[membre]] = await sequelize.query('SELECT owner_id FROM owner_members WHERE user_id = :id', { replacements: { id: res.body.data.user.id } });
  return {
    token: res.body.data.access_token,
    refreshToken: res.body.data.refresh_token,
    user: res.body.data.user,
    ownerId: membre.owner_id,
    identifiants: { phone: corps.phone, email: corps.email, password: MOT_DE_PASSE },
    h: bearer(res.body.data.access_token),
  };
}

/** Crée un super admin en base et le connecte. */
/**
 * Super admin connecté par le VRAI parcours : mot de passe, puis code TOTP
 * (double authentification obligatoire pour ce rôle). `mfa: false` crée un
 * super admin qui ne l'a pas encore configurée (accès limité à la configuration).
 */
async function superAdmin({ mfa = true } = {}) {
  const email = emailUnique('admin');
  const secret = totp.genererSecret();
  await sequelize.query(
    `INSERT INTO users (role_code, first_name, last_name, email, password_hash, totp_secret, totp_enabled_at)
     VALUES ('super_admin', 'Admin', 'Test', :email, :h, :secret, ${mfa ? 'now()' : 'NULL'})`,
    { replacements: { email, h: await bcrypt.hash(MOT_DE_PASSE, 4), secret: mfa ? encrypt(secret) : null } }
  );
  let res = await api().post('/api/v1/auth/connexion').send({ identifiant: email, password: MOT_DE_PASSE });
  if (mfa) {
    if (!res.body.data?.mfa_token) throw new Error(`Connexion super admin : ${res.status} ${JSON.stringify(res.body)}`);
    res = await api().post('/api/v1/auth/mfa').send({ mfa_token: res.body.data.mfa_token, code: totp.codePourPas(secret, totp.pasCourant()) });
  }
  if (!res.body.data?.access_token) throw new Error(`Connexion super admin : ${res.status} ${JSON.stringify(res.body)}`);
  return {
    token: res.body.data.access_token, h: bearer(res.body.data.access_token), user: res.body.data.user,
    refreshToken: res.body.data.refresh_token, email, secret: mfa ? secret : null,
  };
}

/** Code TOTP valide pour un secret (décalage en pas de 30 s : 1 = code suivant, anti-rejeu). */
const codeTotp = (secret, decalage = 0) => totp.codePourPas(secret, totp.pasCourant() + decalage);

async function creerImmeuble(proprio, surcharges = {}) {
  const res = await api().post('/api/v1/immeubles').set(proprio.h)
    .send({ name: `Résidence ${crypto.randomBytes(3).toString('hex')}`, address: 'Route des Almadies', city: 'Dakar', floors_count: 4, ...surcharges });
  if (res.status !== 201) throw new Error(`Immeuble : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.building;
}

async function creerAppartement(proprio, buildingId, surcharges = {}) {
  const res = await api().post('/api/v1/appartements').set(proprio.h)
    .send({ building_id: buildingId, number: `A${crypto.randomBytes(2).toString('hex')}`, type: 'f3', rent_amount: 350000, charges_amount: 0, ...surcharges });
  if (res.status !== 201) throw new Error(`Appartement : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.apartment;
}

async function creerLocataire(proprio, surcharges = {}) {
  const res = await api().post('/api/v1/locataires').set(proprio.h)
    .send({ first_name: 'Mamadou', last_name: 'Ndiaye', phone: telephoneUnique(), email: emailUnique('locataire'), ...surcharges });
  if (res.status !== 201) throw new Error(`Locataire : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.tenant;
}

/** Désactive l'exigence d'état des lieux d'entrée (tests qui n'en ont pas besoin). */
async function desactiverEdlObligatoire(proprio) {
  const res = await api().patch('/api/v1/parametres').set(proprio.h).send({ entry_inspection_policy: 'desactive' });
  if (res.status !== 200) throw new Error(`Paramètres : ${res.status} ${JSON.stringify(res.body)}`);
}

/**
 * Crée un bail et l'active (état des lieux d'entrée désactivé).
 * @returns {Promise<{ lease, building, apartment, tenant }>}
 */
async function bailActif(proprio, { bail = {}, appartement = {} } = {}) {
  await desactiverEdlObligatoire(proprio);
  const building = await creerImmeuble(proprio);
  const apartment = await creerAppartement(proprio, building.id, appartement);
  const tenant = await creerLocataire(proprio);
  const creation = await api().post('/api/v1/baux').set(proprio.h).send({
    apartment_id: apartment.id, tenant_id: tenant.id, start_date: '2026-09-01',
    rent_amount: apartment.rent_amount, deposit_amount: 700000, due_day: 5, ...bail,
  });
  if (creation.status !== 201) throw new Error(`Bail : ${creation.status} ${JSON.stringify(creation.body)}`);
  const activation = await api().post(`/api/v1/baux/${creation.body.data.lease.id}/activer`).set(proprio.h).send({});
  if (activation.status !== 200) throw new Error(`Activation : ${activation.status} ${JSON.stringify(activation.body)}`);
  return { lease: activation.body.data.lease, building, apartment, tenant };
}

/** Active le compte d'un locataire via son invitation (code). */
async function activerLocataire(proprio, tenant) {
  const inv = await api().post(`/api/v1/locataires/${tenant.id}/invitation`).set(proprio.h).send({});
  if (inv.status !== 201) throw new Error(`Invitation : ${inv.status} ${JSON.stringify(inv.body)}`);
  const res = await api().post('/api/v1/auth/locataire/activation').send({
    code: inv.body.data.invitation.code, phone: tenant.phone, password: MOT_DE_PASSE, password_confirmation: MOT_DE_PASSE,
  });
  if (res.status !== 201) throw new Error(`Activation locataire : ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.data.access_token, h: bearer(res.body.data.access_token), user: res.body.data.user };
}

/** Échéances d'un bail, de la plus ancienne à la plus récente. */
async function echeancesDu(proprio, leaseId) {
  const res = await api().get(`/api/v1/echeances?lease_id=${leaseId}&tri=due_date&limit=100`).set(proprio.h);
  if (res.status !== 200) throw new Error(`Échéances : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.items;
}

/** Encaissement en espèces (§ 12) ; ciblé sur une échéance si fournie. */
async function payerEspeces(proprio, leaseId, montant, { scheduleId = null, paidOn = '2026-09-05' } = {}) {
  const res = await api().post('/api/v1/paiements/especes').set(proprio.h)
    .send({ lease_id: leaseId, amount: montant, paid_on: paidOn, ...(scheduleId ? { rent_schedule_id: scheduleId } : {}) });
  if (res.status !== 201) throw new Error(`Paiement : ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Image PNG valide minimale (téléversements). */
async function pngTest(couleur = '#f00') {
  const sharp = require('sharp');
  return sharp({ create: { width: 12, height: 12, channels: 3, background: couleur } }).png().toBuffer();
}

/** Propriétaire + bail actif + compte locataire activé. */
async function proprietaireEtLocataire(options = {}) {
  const proprio = await nouveauProprietaire();
  const bail = await bailActif(proprio, options);
  const locataire = await activerLocataire(proprio, bail.tenant);
  return { proprio, locataire, ...bail };
}

/** Abonnement échu → espace en lecture seule (§ 31). */
async function expirerAbonnement(ownerId) {
  await sequelize.query("UPDATE subscriptions SET current_period_start = '2019-12-01', current_period_end = '2020-01-01' WHERE owner_id = :o", { replacements: { o: ownerId } });
  await require('../../modules/abonnement/service/droits.service.js').invalider(ownerId);
}

/** Publie la version 1 du modèle de bail d'un type (validation juridique supposée faite). */
async function publierModeleBail(type = 'habitation') {
  await sequelize.query("UPDATE lease_templates SET status = 'publie', published_at = now() WHERE lease_type = :type AND version = 1 AND NOT EXISTS (SELECT 1 FROM lease_templates x WHERE x.lease_type = :type AND x.status = 'publie')", { replacements: { type } });
}

/** Nombre de lignes d'une table répondant à une condition SQL paramétrée. */
async function compter(table, condition = 'TRUE', replacements = {}) {
  const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${condition}`, { replacements });
  return n;
}

async function fermer() {
  await sequelize.close();
}

module.exports = {
  api, apiBrute, bearer, MOT_DE_PASSE, telephoneUnique, emailUnique,
  nouveauProprietaire, superAdmin, codeTotp, creerImmeuble, creerAppartement, creerLocataire,
  desactiverEdlObligatoire, bailActif, activerLocataire, fermer, sequelize,
  echeancesDu, payerEspeces, pngTest, proprietaireEtLocataire, expirerAbonnement, publierModeleBail, compter,
};
