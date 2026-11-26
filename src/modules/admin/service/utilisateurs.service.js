'use strict';

const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { User, OwnerMember, Owner, RefreshToken } = require('../../../models/index.js');
const {
  NotFoundError, ConflictError, ValidationError, UnauthorizedError,
} = require('../../../errors/AppError.js');
const { validerMotDePasseAdmin, bcryptConfig } = require('../../../config/security.js');
const bcrypt = require('../../../utils/motDePasse.js');
const { ordre, rechercheTexte } = require('../../../utils/liste.js');
const sessions = require('../../auth/service/session.service.js');
const CodeAcces = require('../../auth/service/codeAcces.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const { PERMISSIONS_ADMIN } = require('../../../config/permissions.js');

/** Toutes les permissions cochées = pas de restriction (NULL), pour suivre les ajouts futurs. */
const normaliserPermissions = (liste) => {
  if (!Array.isArray(liste)) return null;
  const uniques = [...new Set(liste)].filter((p) => PERMISSIONS_ADMIN.includes(p));
  return PERMISSIONS_ADMIN.every((p) => uniques.includes(p)) ? null : uniques.sort();
};

/**
 * Comptes utilisateurs de la plateforme (§ 30 « Utilisateurs », § 32
 * « gestion des comptes actifs / inactifs », « déconnexion distante »).
 *
 * Les colonnes sensibles (empreinte du mot de passe, version de jeton,
 * compteur d'échecs) ne sont JAMAIS sélectionnées : l'administrateur voit
 * seulement si le compte est verrouillé (`is_locked`).
 */

const ATTRIBUTS = [
  'id', 'role_code', 'first_name', 'last_name', 'email', 'phone', 'status', 'email_verified_at',
  'must_change_password', 'last_login_at', 'language', 'created_at', 'updated_at', 'totp_enabled_at', 'admin_permissions',
  [sequelize.literal('("User"."locked_until" IS NOT NULL AND "User"."locked_until" > now())'), 'is_locked'],
];

async function lister(filtres, { limit, offset }) {
  const where = {};
  if (filtres.role) where.role_code = filtres.role;
  if (filtres.status) where.status = filtres.status;
  const texte = rechercheTexte(filtres.q, ['first_name', 'last_name', 'email', 'phone']);
  if (texte) Object.assign(where, texte);
  if (filtres.verrouille !== undefined) {
    const verrouille = { locked_until: { [Op.gt]: new Date() } };
    Object.assign(where, filtres.verrouille ? verrouille : { [Op.and]: [{ [Op.or]: [{ locked_until: null }, { locked_until: { [Op.lte]: new Date() } }] }] });
  }
  return User.findAndCountAll({
    where,
    attributes: ATTRIBUTS,
    order: ordre(filtres.tri, '-created_at'),
    limit,
    offset,
  });
}

async function charger(id, options = {}) {
  const user = await User.findByPk(id, { attributes: ATTRIBUTS, ...options });
  if (!user) throw new NotFoundError('Utilisateur introuvable');
  return user;
}

async function detail(id) {
  const user = await charger(id, {
    include: [{
      model: OwnerMember,
      as: 'memberships',
      attributes: ['id', 'owner_id', 'role_code', 'status'],
      include: [{ model: Owner, as: 'owner', attributes: ['id', 'display_name', 'status'] }],
    }],
  });
  const sessionsActives = await RefreshToken.count({ where: { user_id: id, revoked_at: null, expires_at: { [Op.gt]: new Date() } } });
  return { ...user.toJSON(), active_sessions: sessionsActives };
}

/**
 * Désactivation : le compte perd l'accès à la requête suivante (auth.middleware
 * refuse un compte inactif) et toutes ses sessions sont fermées. Un
 * administrateur ne peut pas se désactiver lui-même.
 *
 * CORRECTIF (plateforme sans administrateur) : l'interdiction de se
 * désactiver soi-même ne suffisait pas — deux super admins pouvaient se
 * désactiver MUTUELLEMENT au même instant. La désactivation d'un super admin
 * est sérialisée par un verrou consultatif, puis refusée (409
 * DERNIER_SUPER_ADMIN) s'il ne resterait aucun autre super admin actif.
 */
async function desactiver(admin, id, { reason }) {
  if (id === admin.id) throw new ConflictError('Vous ne pouvez pas désactiver votre propre compte.', 'ACTION_SUR_SOI_INTERDITE');
  return sequelize.transaction(async (t) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:cle))', {
      replacements: { cle: 'users:desactivation_super_admin' }, type: QueryTypes.SELECT, transaction: t,
    });
    const user = await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (user.status === 'inactif') throw new ConflictError('Ce compte est déjà désactivé.', 'DEJA_INACTIF');
    if (user.role_code === 'super_admin') {
      const autres = await User.count({ where: { role_code: 'super_admin', status: 'actif', id: { [Op.ne]: id } }, transaction: t });
      if (autres < 1) {
        throw new ConflictError('Impossible de désactiver le dernier super administrateur actif.', 'DERNIER_SUPER_ADMIN');
      }
    }
    await User.update({ status: 'inactif' }, { where: { id }, transaction: t });
    await sessions.revoquerToutesLesSessions(id, t);
    await journaliser({
      action: 'utilisateur.changement_statut', entityType: 'user', entityId: id,
      details: { de: 'actif', a: 'inactif', motif: reason, role: user.role_code },
    }, t);
    return charger(id, { transaction: t });
  });
}

async function activer(id) {
  return sequelize.transaction(async (t) => {
    const user = await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (user.status === 'actif') throw new ConflictError('Ce compte est déjà actif.', 'DEJA_ACTIF');
    await User.update({ status: 'actif' }, { where: { id }, transaction: t });
    await journaliser({
      action: 'utilisateur.changement_statut', entityType: 'user', entityId: id,
      details: { de: 'inactif', a: 'actif', role: user.role_code },
    }, t);
    return charger(id, { transaction: t });
  });
}

/**
 * Modification d'un administrateur depuis le back-office KODAFRIK : prénom,
 * nom, e-mail, téléphone. Un e-mail ou un téléphone déjà pris par un autre
 * compte est refusé.
 */
async function modifier(admin, id, { first_name: prenom, last_name: nom, email, phone }) {
  return sequelize.transaction(async (t) => {
    const user = await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (user.role_code !== 'super_admin') {
      throw new ConflictError('Seuls les comptes administrateurs se modifient depuis le back-office.', 'ROLE_NON_ADMIN');
    }
    const changes = {};
    if (prenom !== undefined) changes.first_name = prenom;
    if (nom !== undefined) changes.last_name = nom;
    if (email !== undefined && email !== user.email) changes.email = email;
    if (phone !== undefined && phone !== user.phone) changes.phone = phone;

    if (changes.email || changes.phone) {
      const pris = await User.findOne({
        where: {
          id: { [Op.ne]: id },
          [Op.or]: [
            ...(changes.email ? [sequelize.where(sequelize.fn('lower', sequelize.col('email')), changes.email)] : []),
            ...(changes.phone ? [{ phone: changes.phone }] : []),
          ],
        },
        attributes: ['id'],
        transaction: t,
      });
      if (pris) throw new ConflictError('Cet e-mail ou ce téléphone est déjà utilisé.', 'IDENTIFIANT_UTILISE');
    }
    if (Object.keys(changes).length) {
      await User.update(changes, { where: { id }, transaction: t });
      await journaliser({
        action: 'utilisateur.modification', entityType: 'user', entityId: id,
        details: { champs: Object.keys(changes) },
      }, t);
    }
    return charger(id, { transaction: t });
  });
}

/**
 * Suppression d'un administrateur depuis le back-office KODAFRIK.
 *
 * Suppression LOGIQUE (`deleted_at`, modèle paranoïaque) : le compte ne se
 * connecte plus, ses sessions sont fermées, son code d'accès effacé, et son
 * e-mail et son téléphone redeviennent libres (index uniques limités aux
 * comptes non supprimés). Le journal garde la trace de ce qu'il a fait.
 *
 * Seulement les super admins : un propriétaire ou un locataire porte des
 * baux, des paiements, des quittances — il se désactive, il ne se supprime
 * pas d'ici. Jamais soi-même, jamais le dernier super admin actif.
 */
async function supprimer(admin, id) {
  if (id === admin.id) throw new ConflictError('Vous ne pouvez pas supprimer votre propre compte.', 'ACTION_SUR_SOI_INTERDITE');
  return sequelize.transaction(async (t) => {
    // Même verrou que la désactivation : deux suppressions croisées ne
    // peuvent pas retirer ensemble les deux derniers super admins.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:cle))', {
      replacements: { cle: 'users:desactivation_super_admin' }, type: QueryTypes.SELECT, transaction: t,
    });
    const user = await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (user.role_code !== 'super_admin') {
      throw new ConflictError('Seuls les comptes administrateurs se suppriment depuis le back-office : désactivez ce compte.', 'ROLE_NON_ADMIN');
    }
    if (user.status === 'actif') {
      const autres = await User.count({ where: { role_code: 'super_admin', status: 'actif', id: { [Op.ne]: id } }, transaction: t });
      if (autres < 1) throw new ConflictError('Impossible de supprimer le dernier super administrateur actif.', 'DERNIER_SUPER_ADMIN');
    }
    await sessions.revoquerToutesLesSessions(id, t);
    await sequelize.query('DELETE FROM code_acces_admin WHERE user_id = :id', { replacements: { id }, transaction: t });
    await User.destroy({ where: { id }, transaction: t });
    await journaliser({
      action: 'utilisateur.suppression', entityType: 'user', entityId: id,
      details: { role: user.role_code, email: user.email },
    }, t);
    return { id, supprime: true };
  });
}

/** Levée du verrouillage anti force brute (§ 32) à la demande d'un utilisateur légitime. */
async function deverrouiller(id) {
  return sequelize.transaction(async (t) => {
    await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    await User.update({ failed_login_attempts: 0, locked_until: null }, { where: { id }, transaction: t });
    await journaliser({ action: 'utilisateur.deverrouillage', entityType: 'user', entityId: id }, t);
    return charger(id, { transaction: t });
  });
}

/**
 * Opérations à fort impact (création d'un super admin, rétablissement d'un
 * accès) : le mot de passe de l'administrateur qui agit est redemandé — un
 * jeton d'accès volé ne suffit pas à créer un accès durable.
 */
async function exigerMotDePasseActeur(acteur, motDePasse) {
  const complet = await User.findByPk(acteur.id, { attributes: ['id', 'password_hash'] });
  if (!complet || !motDePasse || !(await bcrypt.compare(String(motDePasse), complet.password_hash))) {
    throw new UnauthorizedError('Mot de passe actuel incorrect', 'MOT_DE_PASSE_INCORRECT');
  }
}

/**
 * Création d'un autre super administrateur. Politique de mot de passe
 * renforcée (la même que le compte initial) et changement exigé à la première
 * connexion : le mot de passe transmis par l'administrateur créateur n'est
 * qu'un secret provisoire. Le nouveau compte devra aussi configurer sa double
 * authentification avant tout accès à l'administration.
 */
async function creerSuperAdmin(acteur, { first_name: prenom, last_name: nom, email, phone = null, password, current_password: motDePasseActeur, permissions = null, code_acces: codeAcces }) {
  await exigerMotDePasseActeur(acteur, motDePasseActeur);
  const erreur = validerMotDePasseAdmin(password, email);
  if (erreur) {
    throw new ValidationError('Données invalides', [erreur.replace('ADMIN_PASSWORD', 'Le mot de passe')], 'MOT_DE_PASSE_FAIBLE');
  }
  const pris = await User.findOne({
    where: {
      [Op.or]: [
        sequelize.where(sequelize.fn('lower', sequelize.col('email')), email),
        ...(phone ? [{ phone }] : []),
      ],
    },
    attributes: ['id'],
  });
  if (pris) throw new ConflictError('Cet e-mail ou ce téléphone est déjà utilisé.', 'IDENTIFIANT_UTILISE');

  const empreinte = await bcrypt.hash(password, bcryptConfig.saltRounds);
  return sequelize.transaction(async (t) => {
    const user = await User.create({
      role_code: 'super_admin',
      first_name: prenom,
      last_name: nom,
      email,
      phone,
      password_hash: empreinte,
      must_change_password: true,
      admin_permissions: normaliserPermissions(permissions),
    }, { transaction: t });
    await journaliser({
      action: 'utilisateur.creation', entityType: 'user', entityId: user.id,
      details: { role: 'super_admin', email, permissions: normaliserPermissions(permissions) ?? 'toutes' },
    }, t);
    // Le code d'accès, dans la même transaction : un compte sans son code ne
    // pourrait pas ouvrir l'administration.
    if (codeAcces) await CodeAcces.definir(user.id, codeAcces, { auteurId: acteur.id, transaction: t });
    return charger(user.id, { transaction: t });
  });
}

/**
 * Code d'accès à quatre chiffres d'un super admin (portail KODAFRIK). Les
 * sessions déjà vérifiées du compte le redemandent ; un code fixe
 * (config/codeAcces.js) ne se change pas.
 */
async function changerCodeAcces(admin, id, { code_acces: code }) {
  const r = await CodeAcces.definir(id, code, { auteurId: admin.id });
  await journaliser({ action: 'utilisateur.code_acces', entityType: 'user', entityId: id, details: {} });
  return r;
}

/**
 * Ce qu'un super admin peut faire (back-office KODAFRIK). Effet immédiat :
 * auth.middleware relit les permissions à chaque requête. On ne modifie pas
 * les siennes (pas d'auto-promotion, pas de verrouillage de soi-même).
 */
async function changerPermissions(admin, id, { permissions }) {
  if (id === admin.id) throw new ConflictError('Vous ne pouvez pas modifier vos propres permissions.', 'ACTION_SUR_SOI_INTERDITE');
  return sequelize.transaction(async (t) => {
    const user = await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (user.role_code !== 'super_admin') throw new ConflictError('Seuls les super administrateurs ont des permissions réglables.', 'ROLE_NON_ADMIN');
    const avant = user.admin_permissions ?? null;
    const apres = normaliserPermissions(permissions);
    await User.update({ admin_permissions: apres }, { where: { id }, transaction: t });
    await journaliser({
      action: 'utilisateur.permissions', entityType: 'user', entityId: id,
      details: { avant: avant ?? 'toutes', apres: apres ?? 'toutes' },
    }, t);
    return charger(id, { transaction: t });
  });
}

/** Mot de passe provisoire aléatoire respectant la politique renforcée. */
function motDePasseProvisoire(email) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
  for (;;) {
    const candidat = Array.from(crypto.randomBytes(18), (o) => alphabet[o % alphabet.length]).join('');
    if (!validerMotDePasseAdmin(candidat, email)) return candidat;
  }
}

/**
 * Rétablissement de l'accès d'un utilisateur par un super admin (seul moyen
 * pour un super admin, qui n'a pas de réinitialisation par e-mail) : mot de
 * passe PROVISOIRE (affiché une seule fois, à changer à la connexion), double
 * authentification à reconfigurer, verrouillage levé, toutes les sessions
 * fermées. Mot de passe de l'administrateur exigé ; jamais sur soi-même.
 */
async function reinitialiserAcces(acteur, id, { current_password: motDePasseActeur, reason: motif }) {
  if (acteur.id === id) {
    throw new ConflictError('Utilisez « changer mon mot de passe » pour votre propre compte.', 'ACTION_SUR_SOI');
  }
  await exigerMotDePasseActeur(acteur, motDePasseActeur);
  return sequelize.transaction(async (t) => {
    const cible = await charger(id, { transaction: t, lock: t.LOCK.UPDATE });
    const provisoire = motDePasseProvisoire(cible.email);
    await User.update({
      password_hash: await bcrypt.hash(provisoire, bcryptConfig.saltRounds),
      must_change_password: true,
      failed_login_attempts: 0,
      locked_until: null,
      totp_secret: null,
      totp_enabled_at: null,
      totp_last_step: null,
      mfa_recovery_codes: [],
    }, { where: { id }, transaction: t });
    await sessions.revoquerToutesLesSessions(id, t);
    await journaliser({
      action: 'utilisateur.reinitialisation_acces', entityType: 'user', entityId: id,
      details: { role: cible.role_code, motif, double_authentification_reinitialisee: Boolean(cible.totp_enabled_at) },
    }, t);
    return { user: await charger(id, { transaction: t }), mot_de_passe_provisoire: provisoire };
  });
}

module.exports = {
  changerPermissions, changerCodeAcces, modifier, supprimer, lister, detail, desactiver, activer, deverrouiller, creerSuperAdmin, reinitialiserAcces };
