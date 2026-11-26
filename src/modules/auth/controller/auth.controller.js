'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created } = require('../../../utils/response.js');
const { cookieRefresh } = require('../../../config/security.js');
const { UnauthorizedError } = require('../../../errors/AppError.js');
const AuthService = require('../service/auth.service.js');
const sessions = require('../service/session.service.js');
const VerificationEmail = require('../service/verificationEmail.service.js');

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
    // Double authentification supprimée : champs gardés pour les clients existants.
    mfa_active: false,
    mfa_a_configurer: false,
    // Ce que ce super admin peut faire (null = tout) : le back-office masque le reste.
    admin_permissions: user.admin_permissions ?? null,
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

/**
 * Inscription, étape 1 : un code part à l'adresse saisie.
 *
 * L'API parle `first_name` comme partout ailleurs, le service parle français :
 * la correspondance se fait ici, sinon l'e-mail salue un prénom vide.
 */
exports.inscriptionCode = asyncHandler(async (req, res) => {
  const { minutes } = await VerificationEmail.demanderCode({
    email: req.body.email,
    prenom: req.body.first_name,
  });
  return ok(res, { expire_dans_minutes: minutes }, 'Code envoyé à votre adresse e-mail.');
});

/** Inscription, étape 2 : le code est contrôlé et la preuve remise au client. */
exports.inscriptionVerifierCode = asyncHandler(async (req, res) => {
  const { jeton } = await VerificationEmail.verifierCode(req.body);
  return ok(res, { email_token: jeton }, 'Adresse vérifiée.');
});

exports.connexion = asyncHandler(async (req, res) => {
  const resultat = await AuthService.connecter(req.body, meta(req));
  return repondreSession(req, res, resultat, 'Connexion réussie');
});

exports.rafraichir = asyncHandler(async (req, res) => {
  const jeton = lireRefresh(req);
  if (!jeton) throw new UnauthorizedError('Session absente, veuillez vous reconnecter', 'SESSION_ABSENTE');
  const resultat = await sessions.rafraichir(jeton, meta(req));
  if (!resultat.ok) {
    // Refus passager (rotation à l'instant) : la session reste valable.
    if (!resultat.code) res.clearCookie('refresh_token', cookieRefresh);
    throw new UnauthorizedError(resultat.motif, resultat.code || 'SESSION_INVALIDE');
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

exports.verifierCode = asyncHandler(async (req, res) => {
  await AuthService.verifierCodeReinitialisation(req.body);
  return ok(res, null, 'Code vérifié. Choisissez votre nouveau mot de passe.');
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

/** Code d'accès du super admin : un jeton d'accès qui ouvre l'administration. */
exports.verifierCodeAcces = asyncHandler(async (req, res) => {
  const CodeAcces = require('../service/codeAcces.service.js');
  const r = await CodeAcces.verifier(req.user, req.body.code, { sessionId: req.sessionId });
  return ok(res, r, "Code d'accès vérifié");
});
