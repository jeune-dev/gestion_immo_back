'use strict';

const { ForbiddenError, UnauthorizedError } = require('../errors/AppError.js');
const { Tenant } = require('../models/index.js');

/**
 * Contrôle d'accès VERTICAL (§ 32) : rôles, permissions et espaces.
 * À placer après `auth`.
 */

/** Le compte doit porter l'un des rôles plateforme indiqués. */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new UnauthorizedError());
  if (roles.includes(req.user.role_code)) return next();
  return next(new ForbiddenError("Vous n'avez pas les droits nécessaires pour cette action.", 'ROLE_INSUFFISANT'));
};

/** Le compte doit détenir la permission (RBAC fin, `roles.permissions`). */
const requirePermission = (permission) => (req, res, next) => {
  if (!req.user) return next(new UnauthorizedError());
  if (req.permissions?.has(permission)) return next();
  return next(new ForbiddenError("Vous n'avez pas la permission d'effectuer cette action.", 'PERMISSION_REFUSEE', { permission }));
};

/**
 * Routes de l'espace propriétaire : le compte doit appartenir à un espace
 * propriétaire actif. Un super admin ou un locataire n'y a pas accès.
 */
const requireProprietaire = (req, res, next) => {
  if (!req.user) return next(new UnauthorizedError());
  if (!req.ownerId) {
    return next(new ForbiddenError('Cette fonctionnalité est réservée aux propriétaires.', 'ESPACE_PROPRIETAIRE_REQUIS'));
  }
  if (req.ownerStatus !== 'actif') {
    return next(new ForbiddenError('Votre espace propriétaire est suspendu. Contactez le support.', 'ESPACE_SUSPENDU'));
  }
  return next();
};

/**
 * Routes de l'espace locataire : charge les fiches locataire rattachées au
 * compte (`tenants.user_id`). Un même compte peut louer chez plusieurs
 * propriétaires : `req.tenantIds` les liste toutes, et chaque requête de
 * l'espace locataire filtre sur ces identifiants — jamais sur un id fourni
 * par le client seul (§ 28 « le locataire ne voit jamais les informations des
 * autres locataires »).
 */
const requireLocataire = async (req, res, next) => {
  try {
    if (!req.user) return next(new UnauthorizedError());
    if (req.user.role_code !== 'locataire') {
      return next(new ForbiddenError('Cette fonctionnalité est réservée aux locataires.', 'ESPACE_LOCATAIRE_REQUIS'));
    }
    const fiches = await Tenant.findAll({ where: { user_id: req.user.id }, attributes: ['id', 'owner_id'] });
    if (!fiches.length) {
      return next(new ForbiddenError('Aucun logement associé à ce compte.', 'AUCUN_LOGEMENT'));
    }
    req.tenantIds = fiches.map((f) => f.id);
    req.tenantOwners = new Map(fiches.map((f) => [f.id, f.owner_id]));
    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = { requireRole, requirePermission, requireProprietaire, requireLocataire };
