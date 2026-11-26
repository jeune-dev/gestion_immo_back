'use strict';

const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { User, RefreshToken } = require('../../../models/index.js');
const bcrypt = require('../../../utils/motDePasse.js');
const { bcryptConfig } = require('../../../config/security.js');
const {
  AppError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError,
} = require('../../../errors/AppError.js');
const { COMPTES_CODE_FIXE, REGLE_CODE, ECHECS_MAX, BLOCAGE_MS } = require('../../../config/codeAcces.js');
const { genererAccessToken } = require('./session.service.js');

/**
 * Le code d'accès à quatre chiffres des super administrateurs (portail KODAFRIK).
 *
 *   - vérifié par le portail après le mot de passe : la session (`sid` du
 *     jeton d'accès) est marquée, et le jeton renvoyé porte `ca` ;
 *   - EXIGÉ par le serveur : `exigerCodeAcces` refuse /admin sans `ca` ;
 *   - 5 échecs → bloqué 15 min ;
 *   - changé depuis le dashboard Kodafrik : les sessions déjà vérifiées du
 *     compte perdent leur drapeau ;
 *   - comptes au code fixe (config/codeAcces.js) : ce code-là seul, jamais modifiable.
 */

const emailDe = (u) => String(u?.email || '').trim().toLowerCase();
const hashFixe = (u) => COMPTES_CODE_FIXE[emailDe(u)] || null;
const estFixe = (u) => Boolean(hashFixe(u));
const formatInvalide = () => new ValidationError('Données invalides', ["Le code d'accès fait exactement quatre chiffres."], 'CODE_ACCES_FORMAT');

async function ligneDe(userId) {
  const [ligne] = await sequelize.query(
    'SELECT code_hash, echecs, bloque_jusqua FROM code_acces_admin WHERE user_id = :id',
    { replacements: { id: userId }, type: QueryTypes.SELECT },
  );
  return ligne || null;
}

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60000));

/**
 * @param {object} user  req.user (super admin connecté)
 * @param {string} code
 * @param {{ sessionId?: string|null, maintenant?: number }} options
 * @returns {Promise<{ valide: true, access_token: string }>}
 */
async function verifier(user, code, { sessionId = null, maintenant = Date.now() } = {}) {
  if (user?.role_code !== 'super_admin') {
    throw new ForbiddenError("Le code d'accès concerne les administrateurs.", 'CODE_ACCES_HORS_ADMIN');
  }
  if (!REGLE_CODE.test(String(code ?? ''))) throw formatInvalide();

  const ligne = await ligneDe(user.id);
  const hash = hashFixe(user) || ligne?.code_hash;
  if (!hash) {
    throw new ForbiddenError(
      "Aucun code d'accès n'est défini pour ce compte. Demandez à un super administrateur de vous en attribuer un.",
      'CODE_ACCES_NON_DEFINI',
    );
  }
  if (ligne?.bloque_jusqua && new Date(ligne.bloque_jusqua).getTime() > maintenant) {
    throw new AppError(`Trop d'essais. Réessayez dans ${minutes(new Date(ligne.bloque_jusqua).getTime() - maintenant)} min.`, 423, true, 'CODE_ACCES_BLOQUE');
  }

  if (!(await bcrypt.compare(String(code), hash))) {
    const echecs = (ligne?.echecs || 0) + 1;
    const bloque = echecs >= ECHECS_MAX;
    await sequelize.query(
      `INSERT INTO code_acces_admin (user_id, code_hash, echecs, bloque_jusqua)
       VALUES (:id, :hash, :echecs, :jusqua)
       ON CONFLICT (user_id) DO UPDATE SET echecs = :echecs, bloque_jusqua = :jusqua`,
      { replacements: { id: user.id, hash, echecs: bloque ? 0 : echecs, jusqua: bloque ? new Date(maintenant + BLOCAGE_MS) : null } },
    );
    if (bloque) throw new AppError(`Trop d'essais. Réessayez dans ${minutes(BLOCAGE_MS)} min.`, 423, true, 'CODE_ACCES_BLOQUE');
    throw new UnauthorizedError("Code d'accès incorrect.", 'CODE_ACCES_INCORRECT');
  }

  if (ligne && (ligne.echecs || ligne.bloque_jusqua)) {
    await sequelize.query('UPDATE code_acces_admin SET echecs = 0, bloque_jusqua = NULL WHERE user_id = :id', { replacements: { id: user.id } });
  }

  // La session du jeton présenté : ses rafraîchissements garderont le code vérifié.
  const sid = typeof sessionId === 'string' && /^[0-9a-f]{32}$/.test(sessionId) ? sessionId : null;
  if (sid) {
    await RefreshToken.update(
      { code_acces_verifie_le: new Date(maintenant) },
      { where: { user_id: user.id, revoked_at: null, token_hash: { [Op.like]: `${sid}%` } } },
    );
  }
  return { valide: true, access_token: genererAccessToken(user, null, { codeAcces: true, sid }) };
}

/** Pose (ou change) le code d'un super administrateur. */
async function definir(cibleId, code, { auteurId = null, transaction = null } = {}) {
  if (!REGLE_CODE.test(String(code ?? ''))) throw formatInvalide();
  const cible = await User.findByPk(cibleId, { attributes: ['id', 'role_code', 'email'], transaction });
  if (!cible || cible.role_code !== 'super_admin') throw new NotFoundError('Administrateur introuvable.');
  if (estFixe(cible)) throw new ConflictError("Le code d'accès de ce compte est fixé et ne peut pas être changé.", 'CODE_ACCES_FIXE');

  const hash = await bcrypt.hash(String(code), bcryptConfig.saltRounds);
  await sequelize.query(
    `INSERT INTO code_acces_admin (user_id, code_hash, echecs, bloque_jusqua, modifie_le, modifie_par)
     VALUES (:id, :hash, 0, NULL, now(), :auteur)
     ON CONFLICT (user_id) DO UPDATE
       SET code_hash = :hash, echecs = 0, bloque_jusqua = NULL, modifie_le = now(), modifie_par = :auteur`,
    { replacements: { id: cible.id, hash, auteur: auteurId }, transaction },
  );
  // L'ancien code ne vaut plus : les sessions déjà vérifiées le redemandent.
  await RefreshToken.update(
    { code_acces_verifie_le: null },
    { where: { user_id: cible.id, code_acces_verifie_le: { [Op.ne]: null } }, transaction },
  );
  return { id: cible.id };
}

module.exports = { verifier, definir, estFixe };
