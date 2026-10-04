'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { RefreshToken, User } = require('../../../models/index.js');
const { jwtConfig, cleHmac } = require('../../../config/security.js');
const hashToken = require('../../../utils/hashToken.js');
const { alerter, TYPES } = require('../../../infrastructure/alertes.service.js');
const logger = require('../../../utils/logger.js');

/**
 * Sessions (§ 5 « gestion de session », § 32 « tokens d'accès courts, refresh
 * token sécurisé, expiration de session, déconnexion distante »).
 *
 * - Jeton d'accès JWT de 15 min, porteur de `tv` (token_version) : révocable
 *   instantanément (auth.middleware compare à la base).
 * - Refresh token JWT opaque pour le client, stocké UNIQUEMENT sous forme
 *   d'empreinte SHA-256, avec l'appareil, l'IP et la date de dernière
 *   utilisation — c'est ce qui permet de lister ses sessions et d'en fermer une
 *   à distance.
 * - ROTATION à chaque rafraîchissement, arbitrée par la base (mise à jour
 *   conditionnelle, reprise de Widjila) ; et DÉTECTION DE REJEU : présenter un
 *   refresh token déjà consommé révoque toutes les sessions du compte (signe
 *   d'un vol de jeton).
 */

const DELAI_GRACE_ROTATION_MS = 30_000;

/**
 * Durée MAXIMALE ABSOLUE d'une session, rotations comprises (point faible de
 * l'audit : une session renouvelée tous les 30 jours vivait indéfiniment).
 * Plus courte pour le super admin (compte le plus sensible).
 */
const dureeMaxSessionMs = (user) => (user?.role_code === 'super_admin'
  ? Number(process.env.SESSION_DUREE_MAX_HEURES_ADMIN || 12) * 3600 * 1000
  : Number(process.env.SESSION_DUREE_MAX_JOURS || 90) * 24 * 3600 * 1000);

/**
 * Préfixe de l'empreinte du refresh token : désigne la session d'origine du
 * jeton d'accès. Le client web ne peut pas présenter son refresh token (cookie
 * httpOnly limité à /api/v1/auth) ; sans `sid`, l'écran « appareils
 * connectés » ne saurait jamais marquer la session courante. Empreinte
 * SHA-256 d'un jeton aléatoire : ne révèle rien du refresh token.
 */
const sessionIdDe = (refreshToken) => hashToken(refreshToken).slice(0, 32);

function genererAccessToken(user, refreshToken = null) {
  return jwt.sign(
    { sub: user.id, role: user.role_code, tv: user.token_version, typ: 'access', ...(refreshToken ? { sid: sessionIdDe(refreshToken) } : {}) },
    cleHmac(jwtConfig.secret),
    { expiresIn: jwtConfig.expiresIn, algorithm: jwtConfig.algorithme }
  );
}

function genererRefreshToken(user) {
  // jti aléatoire : deux sessions ouvertes dans la même seconde ne produisent
  // jamais le même jeton (collision sur l'index unique de l'empreinte).
  return jwt.sign(
    { sub: user.id, typ: 'refresh', jti: crypto.randomUUID() },
    cleHmac(jwtConfig.refreshSecret),
    { expiresIn: jwtConfig.refreshExpiresIn, algorithm: jwtConfig.algorithme }
  );
}

const expirationDe = (jeton) => new Date(jwt.decode(jeton).exp * 1000);

/**
 * Ouvre une session : jeton d'accès + refresh token enregistré.
 * @param {object} user
 * @param {{ ip?: string, userAgent?: string, deviceName?: string, platform?: string }} meta
 */
async function ouvrirSession(user, meta = {}, transaction = null) {
  const refreshToken = genererRefreshToken(user);
  const accessToken = genererAccessToken(user, refreshToken);

  const executer = async (t) => {
    // Plafond de sessions simultanées : la plus ancienne est fermée.
    const actives = await RefreshToken.findAll({
      where: { user_id: user.id, revoked_at: null, expires_at: { [Op.gt]: new Date() } },
      attributes: ['id'],
      order: [['created_at', 'DESC']],
      transaction: t,
    });
    if (actives.length >= jwtConfig.maxSessionsParUtilisateur) {
      const aFermer = actives.slice(jwtConfig.maxSessionsParUtilisateur - 1).map((s) => s.id);
      await RefreshToken.update({ revoked_at: new Date(), revoked_reason: 'plafond' }, { where: { id: aFermer }, transaction: t });
    }
    await RefreshToken.create({
      user_id: user.id,
      token_hash: hashToken(refreshToken),
      expires_at: expirationDe(refreshToken),
      device_name: meta.deviceName || null,
      platform: meta.platform || null,
      ip: meta.ip || null,
      user_agent: meta.userAgent ? String(meta.userAgent).slice(0, 300) : null,
      last_used_at: new Date(),
    }, { transaction: t });
    await User.update({ last_login_at: new Date() }, { where: { id: user.id }, transaction: t });
  };

  if (transaction) await executer(transaction);
  else await sequelize.transaction(executer);

  return { accessToken, refreshToken, expiresIn: jwtConfig.expiresIn };
}

/**
 * Rafraîchit une session avec rotation.
 * @returns {Promise<{ ok: true, accessToken, refreshToken, user } | { ok: false, motif: string }>}
 */
async function rafraichir(refreshToken, meta = {}) {
  let decode;
  try {
    decode = jwt.verify(refreshToken, cleHmac(jwtConfig.refreshSecret), { algorithms: [jwtConfig.algorithme] });
  } catch {
    return { ok: false, motif: 'Session expirée, veuillez vous reconnecter' };
  }
  if (decode.typ !== 'refresh') return { ok: false, motif: 'Jeton invalide' };

  const empreinte = hashToken(refreshToken);
  const stocke = await RefreshToken.findOne({ where: { token_hash: empreinte } });
  if (!stocke || stocke.user_id !== decode.sub) return { ok: false, motif: 'Session inconnue, veuillez vous reconnecter' };

  if (stocke.revoked_at) {
    // Jeton fermé par déconnexion, à distance, par le plafond de sessions ou
    // par une révocation globale : simplement refusé. Seule la réutilisation
    // d'un jeton REMPLACÉ PAR ROTATION trahit un vol (sinon, un vieux jeton
    // déconnecté suffisait à fermer toutes les sessions de la victime).
    if (stocke.revoked_reason && stocke.revoked_reason !== 'rotation') {
      return { ok: false, motif: 'Session fermée, veuillez vous reconnecter' };
    }
    // Deux rafraîchissements quasi simultanés du MÊME client (deux écrans qui
    // expirent ensemble) : le second arrive juste après la rotation. Ce n'est
    // pas un vol — on refuse sans fermer toutes les sessions.
    if (Date.now() - new Date(stocke.revoked_at).getTime() < DELAI_GRACE_ROTATION_MS) {
      return { ok: false, motif: 'Session déjà renouvelée, réessayez' };
    }
    // REJEU tardif d'un jeton déjà consommé : jeton probablement volé. La
    // prudence l'emporte : toutes les sessions du compte sont fermées.
    await revoquerToutesLesSessions(stocke.user_id, null, 'rejeu');
    logger.warn('[session] Rejeu d’un refresh token révoqué — toutes les sessions du compte sont fermées', { utilisateurId: stocke.user_id });
    alerter(TYPES.REJEU_SESSION, 'Rejeu d’un jeton de session révoqué (vol de jeton probable) : toutes les sessions du compte ont été fermées', { utilisateurId: stocke.user_id });
    return { ok: false, motif: 'Session révoquée, veuillez vous reconnecter' };
  }
  if (stocke.expires_at < new Date()) return { ok: false, motif: 'Session expirée, veuillez vous reconnecter' };

  const user = await User.findByPk(stocke.user_id);
  if (!user || user.status !== 'actif') return { ok: false, motif: 'Compte inactif' };
  const debutSession = new Date(stocke.session_started_at || stocke.created_at);
  if (Date.now() - debutSession.getTime() > dureeMaxSessionMs(user)) {
    await RefreshToken.update({ revoked_at: new Date(), revoked_reason: 'expiration' }, { where: { id: stocke.id, revoked_at: null } });
    return { ok: false, motif: 'Session expirée (durée maximale atteinte), veuillez vous reconnecter' };
  }

  return sequelize.transaction(async (t) => {
    // Révocation CONDITIONNELLE : arbitre deux rafraîchissements simultanés.
    const [revoques] = await RefreshToken.update(
      { revoked_at: new Date(), revoked_reason: 'rotation' },
      { where: { id: stocke.id, revoked_at: null }, transaction: t }
    );
    if (revoques === 0) return { ok: false, motif: 'Session révoquée, veuillez vous reconnecter' };

    const nouveau = genererRefreshToken(user);
    const accessToken = genererAccessToken(user, nouveau);
    await RefreshToken.create({
      user_id: user.id,
      token_hash: hashToken(nouveau),
      expires_at: expirationDe(nouveau),
      device_name: stocke.device_name,
      platform: stocke.platform,
      ip: meta.ip || stocke.ip,
      user_agent: meta.userAgent ? String(meta.userAgent).slice(0, 300) : stocke.user_agent,
      last_used_at: new Date(),
      // La session garde sa date de début : la durée maximale est absolue.
      session_started_at: debutSession,
    }, { transaction: t });
    return { ok: true, accessToken, refreshToken: nouveau, user, expiresIn: jwtConfig.expiresIn };
  });
}

/** Ferme la session portée par ce refresh token (déconnexion). */
async function fermerSession(refreshToken) {
  if (!refreshToken) return;
  await RefreshToken.update({ revoked_at: new Date(), revoked_reason: 'deconnexion' }, { where: { token_hash: hashToken(refreshToken), revoked_at: null } });
}

/**
 * Ferme TOUTES les sessions et périme les jetons d'accès en circulation
 * (`token_version` + 1) — changement de mot de passe, rejeu, désactivation.
 */
async function revoquerToutesLesSessions(userId, transaction = null, motif = 'globale') {
  await RefreshToken.update({ revoked_at: new Date(), revoked_reason: motif }, { where: { user_id: userId, revoked_at: null }, transaction });
  await User.increment('token_version', { where: { id: userId }, transaction });
}

/**
 * Sessions actives d'un compte (écran « appareils connectés »). La session
 * courante est reconnue par le refresh token présenté (mobile) ou, à défaut,
 * par le `sid` du jeton d'accès (web).
 */
async function lister(userId, refreshTokenCourant = null, sessionIdCourant = null) {
  const courante = refreshTokenCourant ? hashToken(refreshTokenCourant) : null;
  const sid = typeof sessionIdCourant === 'string' && /^[0-9a-f]{32}$/.test(sessionIdCourant) ? sessionIdCourant : null;
  const sessions = await RefreshToken.findAll({
    where: { user_id: userId, revoked_at: null, expires_at: { [Op.gt]: new Date() } },
    attributes: ['id', 'token_hash', 'device_name', 'platform', 'ip', 'user_agent', 'last_used_at', 'created_at', 'expires_at'],
    order: [['last_used_at', 'DESC']],
  });
  return sessions.map((s) => ({
    id: s.id,
    device_name: s.device_name,
    platform: s.platform,
    ip: s.ip,
    user_agent: s.user_agent,
    last_used_at: s.last_used_at,
    created_at: s.created_at,
    expires_at: s.expires_at,
    current: courante !== null ? s.token_hash === courante : sid !== null && s.token_hash.startsWith(sid),
  }));
}

/** Déconnexion distante d'UNE session (§ 32). */
async function revoquerSession(userId, sessionId) {
  const [n] = await RefreshToken.update(
    { revoked_at: new Date(), revoked_reason: 'distante' },
    { where: { id: sessionId, user_id: userId, revoked_at: null } }
  );
  return n > 0;
}

module.exports = {
  genererAccessToken, ouvrirSession, rafraichir, fermerSession, revoquerToutesLesSessions, lister, revoquerSession,
};
