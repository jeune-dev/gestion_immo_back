'use strict';

const jwt = require('jsonwebtoken');
const { jwtConfig, cleHmac } = require('../config/security.js');
const { User, OwnerMember, Owner } = require('../models/index.js');
const { UnauthorizedError, ForbiddenError } = require('../errors/AppError.js');
const { permissionsDuRole } = require('../modules/auth/service/roles.service.js');

/**
 * Authentification par jeton d'accès (Bearer) — reprise de Widjila.
 *
 * Contrôles, dans l'ordre :
 *   1. signature et expiration (HS256 uniquement — pas de `alg: none`) ;
 *   2. type `access` : un refresh token ou un jeton d'invitation ne vaut JAMAIS
 *      jeton d'accès ;
 *   3. compte existant, non supprimé, ACTIF (§ 32 « gestion des comptes actifs
 *      / inactifs ») — un compte désactivé perd l'accès à la requête suivante ;
 *   4. `token_version` identique à la base : un changement de mot de passe ou
 *      une « déconnexion de tous les appareils » périme à l'instant tous les
 *      jetons déjà émis (§ 32 « déconnexion distante ») ;
 *   5. mot de passe provisoire (`must_change_password`) : 403
 *      CHANGEMENT_MOT_DE_PASSE_REQUIS hors des routes de changement.
 *
 * UNE seule requête SQL : l'utilisateur et, pour un propriétaire, son
 * appartenance active à un espace propriétaire (jointure).
 *
 * Pose sur la requête :
 *   req.user         — l'utilisateur (sans secrets à la sérialisation)
 *   req.permissions  — Set des permissions effectives
 *   req.ownerId      — espace propriétaire (compte propriétaire uniquement)
 */
/**
 * Seules routes ouvertes à un compte dont le mot de passe doit être changé :
 * lire son profil (le client y lit `must_change_password`), changer le mot de
 * passe, se déconnecter.
 */
const ROUTES_AVANT_CHANGEMENT = new Set([
  'GET /api/v1/compte',
  'POST /api/v1/compte/mot-de-passe',
  'POST /api/v1/auth/deconnexion',
]);

/**
 * Super admin sans double authentification (constat E1) : seules la lecture
 * du profil, la configuration TOTP, le changement de mot de passe et la
 * déconnexion sont ouverts. Le reste de l'administration est fermé.
 */
const ROUTES_AVANT_MFA = new Set([
  ...ROUTES_AVANT_CHANGEMENT,
  'POST /api/v1/compte/mfa/initialiser',
  'POST /api/v1/compte/mfa/activer',
]);

const cleRoute = (req) => `${req.method} ${String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '')}`;
const routeOuverteAvantChangement = (req) => ROUTES_AVANT_CHANGEMENT.has(cleRoute(req));
const routeOuverteAvantMfa = (req) => ROUTES_AVANT_MFA.has(cleRoute(req));

const auth = async (req, res, next) => {
  try {
    const entete = req.headers.authorization;
    if (!entete || !entete.startsWith('Bearer ')) {
      return next(new UnauthorizedError('Jeton manquant ou invalide', 'TOKEN_MANQUANT'));
    }

    const decode = jwt.verify(entete.slice(7), cleHmac(jwtConfig.secret), { algorithms: [jwtConfig.algorithme] });
    if (decode.typ !== 'access') {
      return next(new UnauthorizedError('Jeton invalide pour cette opération', 'TOKEN_INVALIDE'));
    }

    const utilisateur = await User.findByPk(decode.sub, {
      attributes: ['id', 'role_code', 'first_name', 'last_name', 'email', 'phone', 'status', 'token_version', 'must_change_password', 'language', 'totp_enabled_at'],
      include: [{
        model: OwnerMember,
        as: 'memberships',
        required: false,
        where: { status: 'actif' },
        attributes: ['owner_id', 'role_code'],
        include: [{ model: Owner, as: 'owner', attributes: ['id', 'status'] }],
      }],
    });
    if (!utilisateur) return next(new UnauthorizedError('Session invalide, veuillez vous reconnecter', 'SESSION_INVALIDE'));
    if (utilisateur.status !== 'actif') {
      return next(new ForbiddenError('Compte désactivé. Contactez le support.', 'COMPTE_INACTIF'));
    }
    if ((decode.tv ?? -1) !== utilisateur.token_version) {
      return next(new UnauthorizedError('Session expirée, veuillez vous reconnecter', 'SESSION_REVOQUEE'));
    }

    // Mot de passe PROVISOIRE (super admin créé par un autre, compte initial) :
    // tant qu'il n'est pas changé, seul le changement de mot de passe est
    // ouvert. Le drapeau n'était auparavant qu'une indication pour le client —
    // un secret transmis par un tiers donnait un accès complet et durable.
    if (utilisateur.must_change_password && !routeOuverteAvantChangement(req)) {
      return next(new ForbiddenError(
        'Vous devez changer votre mot de passe provisoire avant de continuer.',
        'CHANGEMENT_MOT_DE_PASSE_REQUIS'
      ));
    }

    // Double authentification OBLIGATOIRE pour le super admin : tant qu'elle
    // n'est pas configurée, un mot de passe seul n'ouvre pas l'administration.
    if (utilisateur.role_code === 'super_admin' && !utilisateur.totp_enabled_at && !routeOuverteAvantMfa(req)) {
      return next(new ForbiddenError(
        'Configurez la double authentification avant d’accéder à l’administration.',
        'MFA_REQUISE'
      ));
    }

    req.user = utilisateur;
    req.sessionId = decode.sid || null;

    // Espace propriétaire : en V1, un compte propriétaire a exactement une
    // appartenance. Les permissions viennent du rôle DANS l'espace (§ 49).
    const appartenance = utilisateur.memberships?.[0];
    if (appartenance) {
      req.ownerId = appartenance.owner_id;
      req.ownerStatus = appartenance.owner?.status;
      req.permissions = await permissionsDuRole(appartenance.role_code);
    } else {
      req.permissions = await permissionsDuRole(utilisateur.role_code);
    }
    return next();
  } catch (err) {
    return next(err); // TokenExpiredError / JsonWebTokenError → errorHandler (401)
  }
};

module.exports = auth;
