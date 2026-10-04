'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok } = require('../../../utils/response.js');
const { cookieRefresh } = require('../../../config/security.js');
const CompteService = require('../service/compte.service.js');
const sessions = require('../../auth/service/session.service.js');
const MfaService = require('../../auth/service/mfa.service.js');

const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

exports.profil = asyncHandler(async (req, res) => ok(res, await CompteService.profil(req.user, req.ownerId)));

exports.modifierProfil = asyncHandler(async (req, res) => {
  const user = await CompteService.modifierProfil(req.user, req.body);
  return ok(res, { user }, 'Profil mis à jour');
});

/** Nouvelle session pour l'appareil courant (cookie pour le web, corps pour le mobile). */
function donneesSession(req, res, session, supplement = {}) {
  const data = { access_token: session.accessToken, token_type: 'Bearer', expires_in: session.expiresIn, ...supplement };
  if (req.headers.origin) res.cookie('refresh_token', session.refreshToken, { ...cookieRefresh, maxAge: 30 * 24 * 3600 * 1000 });
  else data.refresh_token = session.refreshToken;
  return data;
}

exports.changerMotDePasse = asyncHandler(async (req, res) => {
  const session = await CompteService.changerMotDePasse(req.user, req.body, meta(req));
  return ok(res, donneesSession(req, res, session), 'Mot de passe modifié. Les autres appareils ont été déconnectés.');
});

exports.initialiserMfa = asyncHandler(async (req, res) => {
  const resultat = await MfaService.initialiser(req.user, req.body);
  return ok(res, resultat, "Scannez le QR code dans votre application d'authentification, puis confirmez avec un code.");
});

exports.activerMfa = asyncHandler(async (req, res) => {
  const { codes_secours: codes, session } = await MfaService.activer(req.user, req.body, meta(req));
  return ok(res, donneesSession(req, res, session, { codes_secours: codes }),
    'Double authentification activée. Conservez vos codes de secours : ils ne seront plus affichés.');
});

exports.desactiverMfa = asyncHandler(async (req, res) => {
  await MfaService.desactiver(req.user, req.body);
  return ok(res, null, 'Double authentification désactivée');
});

exports.codesSecoursMfa = asyncHandler(async (req, res) => {
  const resultat = await MfaService.regenererCodesSecours(req.user, req.body);
  return ok(res, resultat, 'Nouveaux codes de secours générés ; les anciens ne sont plus valables.');
});

exports.sessions = asyncHandler(async (req, res) => {
  const courant = req.cookies?.refresh_token || req.headers['x-refresh-token'] || null;
  return ok(res, { sessions: await sessions.lister(req.user.id, courant, req.sessionId) });
});

exports.revoquerSession = asyncHandler(async (req, res) => {
  await CompteService.revoquerSession(req.user, req.params.id);
  return ok(res, null, 'Session fermée');
});

exports.revoquerToutes = asyncHandler(async (req, res) => {
  await CompteService.revoquerToutes(req.user);
  res.clearCookie('refresh_token', cookieRefresh);
  return ok(res, null, 'Tous les appareils ont été déconnectés');
});

exports.enregistrerAppareil = asyncHandler(async (req, res) => {
  await CompteService.enregistrerAppareil(req.user, req.body);
  return ok(res, null, 'Appareil enregistré pour les notifications');
});

exports.supprimerAppareil = asyncHandler(async (req, res) => {
  await CompteService.supprimerAppareil(req.user, req.body);
  return ok(res, null, 'Appareil retiré');
});
