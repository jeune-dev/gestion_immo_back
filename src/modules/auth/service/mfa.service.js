'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const sequelize = require('../../../config/db.js');
const { User } = require('../../../models/index.js');
const { jwtConfig, verrouillageConfig } = require('../../../config/security.js');
const bcrypt = require('../../../utils/motDePasse.js');
const hashToken = require('../../../utils/hashToken.js');
const totp = require('../../../utils/totp.js');
const {
  UnauthorizedError, ConflictError, ForbiddenError, ValidationError,
} = require('../../../errors/AppError.js');
const sessions = require('./session.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const { alerter, TYPES } = require('../../../infrastructure/alertes.service.js');

/**
 * Double authentification TOTP (constat E1 de l'audit de sécurité).
 *
 * - OBLIGATOIRE pour le super admin : tant qu'elle n'est pas configurée, son
 *   jeton d'accès n'ouvre que la configuration (auth.middleware) ; une fois
 *   active, la connexion par mot de passe seul ne délivre qu'un jeton « mfa »
 *   de 5 minutes, échangé contre une session par POST /auth/mfa.
 * - Facultative pour les autres comptes (même mécanisme, désactivable).
 * - Anti-rejeu : un code (un pas de 30 s) ne sert qu'une fois.
 * - Force brute bornée : chaque code faux compte dans le verrouillage du
 *   compte (5 échecs → 15 min), comme un mauvais mot de passe.
 * - 10 codes de secours à usage unique, stockés en empreintes SHA-256.
 */

const DUREE_JETON_MFA = '5m';
const NB_CODES_SECOURS = 10;
const EMETTEUR = () => process.env.APP_NAME || 'Gestion immobilière';

// Clé DÉRIVÉE : un jeton « mfa » ne peut jamais être confondu avec un jeton
// d'accès, même si la vérification du type était oubliée ailleurs.
const cleJetonMfa = () => crypto.createHmac('sha256', jwtConfig.secret).update('jeton-double-authentification').digest();

const estSuperAdmin = (user) => user.role_code === 'super_admin';
const mfaActive = (user) => Boolean(user.totp_enabled_at);

/** Jeton intermédiaire délivré après un mot de passe correct. */
function emettreJetonMfa(user) {
  return jwt.sign({ sub: user.id, typ: 'mfa', tv: user.token_version }, cleJetonMfa(), {
    expiresIn: DUREE_JETON_MFA, algorithm: jwtConfig.algorithme,
  });
}

function lireJetonMfa(jeton) {
  try {
    const decode = jwt.verify(String(jeton || ''), cleJetonMfa(), { algorithms: [jwtConfig.algorithme] });
    return decode.typ === 'mfa' ? decode : null;
  } catch {
    return null;
  }
}

/** Codes de secours lisibles (XXXX-XXXX) et leurs empreintes. */
function nouveauxCodesSecours() {
  const codes = Array.from({ length: NB_CODES_SECOURS }, () => {
    const brut = totp.versBase32(crypto.randomBytes(5)).slice(0, 8);
    return `${brut.slice(0, 4)}-${brut.slice(4)}`;
  });
  return { codes, empreintes: codes.map((c) => hashToken(normaliserCodeSecours(c))) };
}
const normaliserCodeSecours = (code) => String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');

/** Échec du second facteur : même compteur ATOMIQUE que les mots de passe faux. */
async function compterEchec(user) {
  const [[ligne]] = await sequelize.query(
    `UPDATE users SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE WHEN failed_login_attempts + 1 >= :max THEN now() + (:minutes || ' minutes')::interval ELSE locked_until END
      WHERE id = :id RETURNING failed_login_attempts`,
    { replacements: { id: user.id, max: verrouillageConfig.maxTentatives, minutes: String(verrouillageConfig.dureeMinutes) } }
  );
  if (ligne?.failed_login_attempts >= verrouillageConfig.maxTentatives) {
    await User.update({ failed_login_attempts: 0 }, { where: { id: user.id } });
    await journaliser({ action: 'compte.verrouillage', entityType: 'user', entityId: user.id, acteur: user, details: { motif: 'echecs_double_authentification' } });
    if (user.role_code === 'super_admin') {
      alerter(TYPES.VERROUILLAGE_SUPER_ADMIN, 'Compte super administrateur verrouillé après des codes de double authentification faux', { utilisateurId: user.id });
    }
  }
}

/**
 * Vérifie un code TOTP (anti-rejeu ATOMIQUE : le pas n'est consommé qu'une
 * fois, même par deux requêtes simultanées) ou un code de secours (consommé).
 * @returns {Promise<'totp'|'secours'|null>}
 */
async function verifierSecondFacteur(user, { code, code_secours: codeSecours }) {
  if (code) {
    const pas = totp.verifier(user.totp_secret, String(code), { dernierPas: user.totp_last_step });
    if (pas === null) return null;
    const [lignes] = await sequelize.query(
      'UPDATE users SET totp_last_step = :pas WHERE id = :id AND (totp_last_step IS NULL OR totp_last_step < :pas) RETURNING id',
      { replacements: { id: user.id, pas } }
    );
    return lignes.length ? 'totp' : null;
  }
  if (codeSecours) {
    const empreinte = hashToken(normaliserCodeSecours(codeSecours));
    const [lignes] = await sequelize.query(
      `UPDATE users SET mfa_recovery_codes = mfa_recovery_codes - CAST(:empreinte AS text)
        WHERE id = :id AND jsonb_exists(mfa_recovery_codes, :empreinte) RETURNING id`,
      { replacements: { id: user.id, empreinte } }
    );
    return lignes.length ? 'secours' : null;
  }
  return null;
}

/**
 * Seconde étape de la connexion : jeton « mfa » + code → session.
 * @returns {Promise<{ user, session, codes_secours_restants: number }>}
 */
async function finaliserConnexion({ mfa_token: jeton, code, code_secours: codeSecours }, meta) {
  const refus = new UnauthorizedError('Code de vérification invalide ou expiré', 'CODE_MFA_INVALIDE');
  const decode = lireJetonMfa(jeton);
  if (!decode) throw new UnauthorizedError('Étape de vérification expirée, reconnectez-vous', 'JETON_MFA_INVALIDE');
  const user = await User.findByPk(decode.sub);
  if (!user || user.status !== 'actif' || !mfaActive(user) || user.token_version !== decode.tv) {
    throw new UnauthorizedError('Étape de vérification expirée, reconnectez-vous', 'JETON_MFA_INVALIDE');
  }
  if (user.locked_until && user.locked_until > new Date()) throw refus;

  const facteur = await verifierSecondFacteur(user, { code, code_secours: codeSecours });
  if (!facteur) {
    await compterEchec(user);
    throw refus;
  }
  await user.reload();
  if (user.failed_login_attempts || user.locked_until) await user.update({ failed_login_attempts: 0, locked_until: null });
  const session = await sessions.ouvrirSession(user, meta);
  await journaliser({
    action: 'compte.connexion_double_authentification', entityType: 'user', entityId: user.id, acteur: user,
    details: { facteur, codes_secours_restants: user.mfa_recovery_codes.length },
  });
  return { user, session, codes_secours_restants: user.mfa_recovery_codes.length };
}

async function exigerMotDePasse(user, motDePasse) {
  if (!motDePasse || !(await bcrypt.compare(String(motDePasse), user.password_hash))) {
    throw new UnauthorizedError('Mot de passe actuel incorrect', 'MOT_DE_PASSE_INCORRECT');
  }
}

/** Étape 1 de la configuration : nouveau secret (non actif tant qu'il n'est pas confirmé). */
async function initialiser(acteur, { current_password: motDePasse }) {
  const user = await User.findByPk(acteur.id);
  await exigerMotDePasse(user, motDePasse);
  if (mfaActive(user)) throw new ConflictError('La double authentification est déjà active', 'MFA_DEJA_ACTIVE');
  const secret = totp.genererSecret();
  await user.update({ totp_secret: secret, totp_last_step: null });
  await journaliser({ action: 'compte.double_authentification_initialisation', entityType: 'user', entityId: user.id });
  return {
    secret,
    otpauth_url: totp.uriOtpauth({ secret, compte: user.email || user.phone || user.id, emetteur: EMETTEUR() }),
  };
}

/**
 * Étape 2 : confirmation par un premier code. Active la double
 * authentification, délivre les codes de secours (montrés UNE seule fois),
 * ferme toutes les sessions ouvertes sans second facteur et en ouvre une
 * nouvelle pour l'appareil courant.
 */
async function activer(acteur, { code }, meta) {
  const user = await User.findByPk(acteur.id);
  if (mfaActive(user)) throw new ConflictError('La double authentification est déjà active', 'MFA_DEJA_ACTIVE');
  if (!user.totp_secret) throw new ConflictError("Initialisez d'abord la double authentification", 'MFA_NON_INITIALISEE');
  const pas = totp.verifier(user.totp_secret, String(code || ''), { dernierPas: user.totp_last_step });
  if (pas === null) {
    await compterEchec(user);
    throw new ValidationError('Données invalides', ['Code de vérification incorrect'], 'CODE_MFA_INVALIDE');
  }
  const { codes, empreintes } = nouveauxCodesSecours();
  const session = await sequelize.transaction(async (t) => {
    await user.update({ totp_enabled_at: new Date(), totp_last_step: pas, mfa_recovery_codes: empreintes }, { transaction: t });
    await sessions.revoquerToutesLesSessions(user.id, t);
    await user.reload({ transaction: t });
    await journaliser({ action: 'compte.double_authentification_activation', entityType: 'user', entityId: user.id }, t);
    return sessions.ouvrirSession(user, meta, t);
  });
  return { codes_secours: codes, session };
}

/** Désactivation : impossible pour un super admin (obligatoire), sinon mot de passe + code. */
async function desactiver(acteur, { current_password: motDePasse, code, code_secours: codeSecours }) {
  const user = await User.findByPk(acteur.id);
  if (estSuperAdmin(user)) {
    throw new ForbiddenError('La double authentification est obligatoire pour un super administrateur', 'MFA_OBLIGATOIRE');
  }
  if (!mfaActive(user)) throw new ConflictError("La double authentification n'est pas active", 'MFA_INACTIVE');
  await exigerMotDePasse(user, motDePasse);
  if (!(await verifierSecondFacteur(user, { code, code_secours: codeSecours }))) {
    await compterEchec(user);
    throw new UnauthorizedError('Code de vérification invalide', 'CODE_MFA_INVALIDE');
  }
  await user.update({ totp_secret: null, totp_enabled_at: null, totp_last_step: null, mfa_recovery_codes: [] });
  await journaliser({ action: 'compte.double_authentification_desactivation', entityType: 'user', entityId: user.id });
}

/** Nouveaux codes de secours (les anciens deviennent invalides). */
async function regenererCodesSecours(acteur, { current_password: motDePasse, code }) {
  const user = await User.findByPk(acteur.id);
  if (!mfaActive(user)) throw new ConflictError("La double authentification n'est pas active", 'MFA_INACTIVE');
  await exigerMotDePasse(user, motDePasse);
  if (!(await verifierSecondFacteur(user, { code }))) {
    await compterEchec(user);
    throw new UnauthorizedError('Code de vérification invalide', 'CODE_MFA_INVALIDE');
  }
  const { codes, empreintes } = nouveauxCodesSecours();
  await user.update({ mfa_recovery_codes: empreintes });
  await journaliser({ action: 'compte.double_authentification_codes_secours', entityType: 'user', entityId: user.id });
  return { codes_secours: codes };
}

module.exports = {
  emettreJetonMfa, lireJetonMfa, finaliserConnexion, initialiser, activer, desactiver, regenererCodesSecours,
  verifierSecondFacteur, mfaActive, estSuperAdmin, compterEchec, DUREE_JETON_MFA,
};
