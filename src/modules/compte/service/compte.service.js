'use strict';

const sequelize = require('../../../config/db.js');
const { User, DeviceToken, Owner } = require('../../../models/index.js');
const { bcryptConfig, validerMotDePasseAdmin } = require('../../../config/security.js');
const bcrypt = require('../../../utils/motDePasse.js');
const {
  UnauthorizedError, ConflictError, NotFoundError, ValidationError,
} = require('../../../errors/AppError.js');
const sessions = require('../../auth/service/session.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');
const droits = require('../../abonnement/service/droits.service.js');

async function profil(user, ownerId) {
  const complet = await User.findByPk(user.id);
  const resultat = { user: complet.toJSON() };
  if (ownerId) {
    const owner = await Owner.findByPk(ownerId, { attributes: ['id', 'display_name', 'company_name', 'city', 'country', 'currency', 'status'] });
    resultat.owner = owner;
    resultat.abonnement = await droits.etat(ownerId);
  }
  return resultat;
}

const CHAMPS_PROFIL = ['first_name', 'last_name', 'email', 'language'];

/**
 * Modification du profil.
 *
 * CORRECTIF (prise de contrôle de compte) : l'e-mail est le canal du « mot de
 * passe oublié » (§ 5). Le changer exige désormais le mot de passe ACTUEL —
 * sans cela, un jeton d'accès volé (15 min) suffisait à détourner l'e-mail
 * puis à réinitialiser le mot de passe : compte perdu pour de bon. La
 * nouvelle adresse n'est pas vérifiée (`email_verified_at` remis à null) et
 * le changement est journalisé à part (§ 40).
 */
async function modifierProfil(user, { current_password: actuel, ...donnees }) {
  const complet = await User.findByPk(user.id);
  const emailChange = donnees.email !== undefined && (donnees.email || null) !== (complet.email ? complet.email.toLowerCase() : null);
  if (emailChange) {
    if (!actuel) {
      throw new ValidationError('Données invalides', ["Le mot de passe actuel est requis pour changer d'e-mail"], 'MOT_DE_PASSE_ACTUEL_REQUIS');
    }
    if (!(await bcrypt.compare(actuel, complet.password_hash))) {
      throw new UnauthorizedError('Mot de passe actuel incorrect', 'MOT_DE_PASSE_INCORRECT');
    }
    if (donnees.email) {
      const pris = await User.findOne({
        where: sequelize.where(sequelize.fn('lower', sequelize.col('email')), donnees.email),
        attributes: ['id'],
      });
      if (pris && pris.id !== complet.id) throw new ConflictError('Cet e-mail est déjà utilisé', 'EMAIL_UTILISE');
    }
  } else {
    delete donnees.email;
  }
  const avant = complet.toJSON();
  await sequelize.transaction(async (t) => {
    await complet.update(emailChange ? { ...donnees, email_verified_at: null } : donnees, {
      transaction: t, fields: [...CHAMPS_PROFIL, 'email_verified_at'],
    });
    const details = difference(avant, donnees, CHAMPS_PROFIL);
    if (Object.keys(details).length) {
      await journaliser({ action: 'compte.modification', entityType: 'user', entityId: complet.id, details }, t);
    }
    if (emailChange) {
      await journaliser({
        action: 'compte.changement_email', entityType: 'user', entityId: complet.id,
        details: { avant: avant.email ?? null, apres: donnees.email || null },
      }, t);
    }
  });
  return complet;
}

/**
 * Changement de mot de passe (§ 5). Toutes les AUTRES sessions sont fermées
 * et les jetons d'accès en circulation périmés ; l'appareil courant reçoit une
 * nouvelle session pour ne pas se déconnecter lui-même.
 */
async function changerMotDePasse(user, { current_password: actuel, password }, meta) {
  const complet = await User.findByPk(user.id);
  if (!(await bcrypt.compare(actuel, complet.password_hash))) {
    throw new UnauthorizedError('Mot de passe actuel incorrect', 'MOT_DE_PASSE_INCORRECT');
  }
  // Le mot de passe provisoire (connu de celui qui a créé le compte) ne peut
  // pas être « changé » pour lui-même.
  if (await bcrypt.compare(password, complet.password_hash)) {
    throw new ValidationError('Données invalides', ["Le nouveau mot de passe doit être différent de l'actuel"], 'MOT_DE_PASSE_IDENTIQUE');
  }
  // Super admin : la politique renforcée s'applique à CHAQUE changement, pas
  // seulement à la création du compte (constat M3).
  if (complet.role_code === 'super_admin') {
    const erreur = validerMotDePasseAdmin(password, complet.email);
    if (erreur) throw new ValidationError('Données invalides', [erreur], 'MOT_DE_PASSE_TROP_FAIBLE');
  }
  const empreinte = await bcrypt.hash(password, bcryptConfig.saltRounds);
  return sequelize.transaction(async (t) => {
    await complet.update({ password_hash: empreinte, must_change_password: false }, { transaction: t });
    await sessions.revoquerToutesLesSessions(complet.id, t);
    await complet.reload({ transaction: t });
    await journaliser({ action: 'compte.changement_mot_de_passe', entityType: 'user', entityId: complet.id }, t);
    return sessions.ouvrirSession(complet, meta, t);
  });
}

async function revoquerSession(user, sessionId) {
  const fait = await sessions.revoquerSession(user.id, sessionId);
  if (!fait) throw new NotFoundError('Session introuvable');
  await journaliser({ action: 'compte.deconnexion_distante', entityType: 'session', entityId: sessionId });
}

/** Déconnexion de TOUS les appareils (§ 32 « déconnexion distante »). */
async function revoquerToutes(user) {
  await sequelize.transaction(async (t) => {
    await sessions.revoquerToutesLesSessions(user.id, t);
    await journaliser({ action: 'compte.deconnexion_tous_appareils', entityType: 'user', entityId: user.id }, t);
  });
}

/**
 * Enregistre le jeton push d'un appareil. Un jeton appartient à UN compte :
 * s'il servait à un autre compte sur le même téléphone, il lui est retiré
 * (sinon l'ancien utilisateur recevrait les notifications du nouveau).
 */
async function enregistrerAppareil(user, { token, platform }) {
  await sequelize.transaction(async (t) => {
    await DeviceToken.destroy({ where: { token }, transaction: t });
    await DeviceToken.create({ user_id: user.id, token, platform, last_seen_at: new Date() }, { transaction: t });
  });
}

async function supprimerAppareil(user, { token }) {
  await DeviceToken.destroy({ where: { token, user_id: user.id } });
}

module.exports = { profil, modifierProfil, changerMotDePasse, revoquerSession, revoquerToutes, enregistrerAppareil, supprimerAppareil };
