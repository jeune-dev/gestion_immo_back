'use strict';

const crypto = require('crypto');
const { TenantInvitation } = require('../../../models/index.js');
const hashToken = require('../../../utils/hashToken.js');
const parametres = require('../../parametres/service/parametres.service.js');
const { comparerTempsConstant } = require('../../../infrastructure/paiement/signature.js');

/**
 * Invitation d'un locataire (§ 5, options A et B).
 *
 * Deux secrets à usage unique, jamais stockés en clair :
 *   - un JETON long (lien d'activation) — empreinte SHA-256 ;
 *   - un CODE à 8 chiffres (saisie manuelle, partage par SMS/oral) — HMAC lié
 *     à la fiche locataire : 10^8 combinaisons, 5 essais par invitation, et
 *     le code seul ne suffit pas (le téléphone du locataire est exigé).
 */

const secret = () => process.env.INVITATION_SECRET || process.env.JWT_SECRET;
const MAX_ESSAIS = 5;

function empreinteCode(tenantId, code) {
  return crypto.createHmac('sha256', secret()).update(`${tenantId}:${code}`).digest('hex');
}

/**
 * Crée une invitation (et révoque les précédentes non utilisées).
 * @returns {Promise<{ token: string, code: string, expiresAt: Date }>}
 */
async function creer(tenant, auteurId, transaction) {
  const { duree_jours: jours } = await parametres.plateforme('invitation');
  const token = crypto.randomBytes(32).toString('base64url');
  const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, '0');
  const expiresAt = new Date(Date.now() + jours * 86400 * 1000);

  await TenantInvitation.update(
    { revoked_at: new Date() },
    { where: { tenant_id: tenant.id, used_at: null, revoked_at: null }, transaction }
  );
  await TenantInvitation.create({
    owner_id: tenant.owner_id,
    tenant_id: tenant.id,
    token_hash: hashToken(token),
    code_hash: empreinteCode(tenant.id, code),
    expires_at: expiresAt,
    created_by: auteurId,
  }, { transaction });
  return { token, code, expiresAt, jours };
}

const estValide = (inv) => inv && !inv.used_at && !inv.revoked_at && inv.expires_at > new Date() && inv.attempts < MAX_ESSAIS;

/** Invitation valide correspondant à un jeton de lien, ou null. */
async function parJeton(token, transaction) {
  const inv = await TenantInvitation.findOne({ where: { token_hash: hashToken(token) }, transaction, lock: transaction?.LOCK.UPDATE });
  return estValide(inv) ? inv : null;
}

/**
 * Invitation valide pour (fiches locataire du téléphone, code), ou null.
 * Chaque échec consomme un essai sur les invitations candidates.
 */
async function parCode(tenantIds, code, transaction) {
  if (!tenantIds.length) return null;
  const candidates = await TenantInvitation.findAll({
    where: { tenant_id: tenantIds, used_at: null, revoked_at: null },
    transaction,
    lock: transaction?.LOCK.UPDATE,
  });
  const valides = candidates.filter(estValide);
  const trouvee = valides.find((inv) => comparerTempsConstant(inv.code_hash, empreinteCode(inv.tenant_id, code)));
  if (!trouvee && valides.length) {
    await TenantInvitation.increment('attempts', { where: { id: valides.map((v) => v.id) }, transaction });
  }
  return trouvee || null;
}

module.exports = { creer, parJeton, parCode, empreinteCode, estValide, MAX_ESSAIS };
