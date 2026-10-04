'use strict';

const sequelize = require('../config/db.js');

/**
 * Purge des données techniques échues (minimisation, § 1 recommandations
 * CNIL ; performances des tables à forte rotation).
 *
 *   - refresh tokens expirés ou révoqués depuis plus de 30 jours ;
 *   - clés d'idempotence expirées ;
 *   - codes de réinitialisation de plus de 24 h ;
 *   - invitations expirées ou utilisées depuis plus de 90 jours ;
 *   - notifications LUES de plus de 12 mois.
 *
 * Jamais de donnée métier ni financière : elles relèvent de la suppression
 * logique (§ 42) et du journal d'audit.
 * Suppressions par LOTS (10 000 lignes par défaut, au plus 50 lots par table
 * et par passage) : pas de verrou long sur une table très sollicitée ; le
 * reliquat éventuel part au passage suivant.
 */

const TAILLE_LOT = 10000;
const LOTS_MAX = 50;

const REQUETES = {
  refresh_tokens: `DELETE FROM refresh_tokens WHERE id IN (
      SELECT id FROM refresh_tokens
       WHERE (expires_at < now() - interval '30 days') OR (revoked_at < now() - interval '30 days')
       LIMIT :taille)`,
  idempotency_keys: 'DELETE FROM idempotency_keys WHERE id IN (SELECT id FROM idempotency_keys WHERE expires_at < now() LIMIT :taille)',
  password_resets: "DELETE FROM password_resets WHERE id IN (SELECT id FROM password_resets WHERE created_at < now() - interval '24 hours' LIMIT :taille)",
  tenant_invitations: `DELETE FROM tenant_invitations WHERE id IN (
      SELECT id FROM tenant_invitations
       WHERE COALESCE(used_at, revoked_at, expires_at) < now() - interval '90 days' LIMIT :taille)`,
  notifications: `DELETE FROM notifications WHERE id IN (
      SELECT id FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - interval '12 months' LIMIT :taille)`,
};

/**
 * @param {{ taille?: number, lotsMax?: number }} [options]  réglages des lots (tests, maintenance)
 * @returns {Promise<Record<string, number>>} lignes supprimées par table
 */
async function nettoyer({ taille = TAILLE_LOT, lotsMax = LOTS_MAX } = {}) {
  const bilan = {};
  for (const [table, sql] of Object.entries(REQUETES)) {
    let total = 0;
    for (let lot = 0; lot < lotsMax; lot += 1) {
      const [, meta] = await sequelize.query(sql, { replacements: { taille } });
      const n = meta?.rowCount ?? 0;
      total += n;
      if (n < taille) break;
    }
    bilan[table] = total;
  }
  return bilan;
}

module.exports = { nettoyer, TAILLE_LOT, LOTS_MAX };
