'use strict';

const { Role } = require('../../../models/index.js');

/**
 * Permissions par rôle, lues en base et gardées en mémoire (§ 32 RBAC).
 *
 * Chaque requête authentifiée a besoin des permissions de son rôle : les relire
 * en base à chaque fois coûterait une requête de plus par appel pour une table
 * qui ne change presque jamais. Le cache vit 60 s (`ROLES_CACHE_TTL_MS`) :
 * une modification faite par le super admin sur un autre worker PM2 est prise
 * en compte au plus tard une minute après ; sur ce worker-ci, immédiatement
 * (`invalider`).
 */

const TTL_MS = parseInt(process.env.ROLES_CACHE_TTL_MS || '60000', 10);

let cache = null;          // Map<code, Set<permission>>
let chargeLe = 0;
let chargementEnCours = null;

async function charger() {
  const roles = await Role.findAll({ attributes: ['code', 'permissions'] });
  cache = new Map(roles.map((r) => [r.code, new Set(r.permissions || [])]));
  chargeLe = Date.now();
  return cache;
}

async function tables() {
  if (cache && Date.now() - chargeLe < TTL_MS) return cache;
  if (!chargementEnCours) {
    chargementEnCours = charger().finally(() => { chargementEnCours = null; });
  }
  return chargementEnCours;
}

/** @returns {Promise<Set<string>>} permissions du rôle (vide si inconnu). */
async function permissionsDuRole(code) {
  const t = await tables();
  return t.get(code) || new Set();
}

function invalider() {
  cache = null;
}

module.exports = { permissionsDuRole, invalider };
