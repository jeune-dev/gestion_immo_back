'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created } = require('../../../utils/response.js');
const { cookieRefresh } = require('../../../config/security.js');
const { UnauthorizedError } = require('../../../errors/AppError.js');
const AuthService = require('../service/auth.service.js');
const sessions = require('../service/session.service.js');
const MfaService = require('../service/mfa.service.js');

/**
 * Client NAVIGATEUR (super admin web) : le refresh token part en cookie
 * httpOnly SameSite=Strict, jamais dans le corps (une faille XSS ne peut pas
 * l'exfiltrer). Client MOBILE (pas d'en-tête Origin) : il le reçoit dans le
 * corps et le stocke dans le coffre sécurisé de l'appareil. Critère repris de
 * Widjila.
 */
const estNavigateur = (req) => Boolean(req.headers.origin);
const DUREE_COOKIE_MS = 30 * 24 * 3600 * 1000;

const meta = (req) => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
  deviceName: req.body?.device_name,
  platform: req.body?.platform,
});

function formatUtilisateur(user) {
  return {
    id: user.id,
    role: user.role_code,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    phone: user.phone,
    status: user.status,
    language: user.language,
    must_change_password: user.must_change_password,
    mfa_active: Boolean(user.totp_enabled_at),
    // Super admin sans double authentification : seule sa configuration est ouverte.
    mfa_a_configurer: user.role_code === 'super_admin' && !user.totp_enabled_at,
  };
}

function repondreSession(req, res, { user, session }, message, statut = 200) {
  const data = {
    access_token: session.accessToken,
    token_type: 'Bearer',
    expires_in: session.expiresIn,
    user: formatUtilisateur(user),
  };
  if (estNavigateur(req)) res.cookie('refresh_token', session.refreshToken, { ...cookieRefresh, maxAge: DUREE_COOKIE_MS });
  else data.refresh_token = session.refreshToken;
  return statut === 201 ? created(res, data, message) : ok(res, data, message);
}

const lireRefresh = (req) => req.cookies?.refresh_token || req.body?.refresh_token || null;

exports.inscription = asyncHandler(async (req, res) => {
  const resultat = await AuthService.inscrireProprietaire(req.body, meta(req));
  return repondreSession(req, res, resultat, 'Compte propriétaire créé', 201);
});

exports.connexion = asyncHandler(async (req, res) => {
  const resultat = await AuthService.connecter(req.body, meta(req));
  if (resultat.mfa) {
    // Double authentification : aucune session tant que le code n'est pas donné.
    return ok(res, { mfa_requis: true, mfa_token: resultat.mfa.jeton, expires_in: resultat.mfa.expiresIn }, 'Code de vérification requis');
  }
  return repondreSession(req, res, resultat, 'Connexion réussie');
});

/** Seconde étape de la connexion (double authentification) : code TOTP ou code de secours. */
exports.mfa = asyncHandler(async (req, res) => {
  const resultat = await MfaService.finaliserConnexion(req.body, meta(req));
  return repondreSession(req, res, resultat, 'Connexion réussie');
});

exports.rafraichir = asyncHandler(async (req, res) => {
  const jeton = lireRefresh(req);
  if (!jeton) throw new UnauthorizedError('Session absente, veuillez vous reconnecter', 'SESSION_ABSENTE');
  const resultat = await sessions.rafraichir(jeton, meta(req));
  if (!resultat.ok) {
    res.clearCookie('refresh_token', cookieRefresh);
    throw new UnauthorizedError(resultat.motif, 'SESSION_INVALIDE');
  }
  return repondreSession(req, res, { user: resultat.user, session: resultat }, 'Session renouvelée');
});

exports.deconnexion = asyncHandler(async (req, res) => {
  await sessions.fermerSession(lireRefresh(req));
  res.clearCookie('refresh_token', cookieRefresh);
  return ok(res, null, 'Déconnexion réussie');
});

exports.motDePasseOublie = asyncHandler(async (req, res) => {
  await AuthService.demanderReinitialisation(req.body);
  // Réponse identique que le compte existe ou non (anti-énumération).
  return ok(res, null, 'Si un compte correspond, un code de réinitialisation a été envoyé.');
});

exports.reinitialiser = asyncHandler(async (req, res) => {
  await AuthService.reinitialiserMotDePasse(req.body);
  return ok(res, null, 'Mot de passe réinitialisé. Vous pouvez vous connecter.');
});

exports.activerLocataire = asyncHandler(async (req, res) => {
  const resultat = await AuthService.activerLocataire(req.body, meta(req));
  return repondreSession(req, res, resultat, 'Compte locataire activé', 201);
});

exports.formatUtilisateur = formatUtilisateur;
