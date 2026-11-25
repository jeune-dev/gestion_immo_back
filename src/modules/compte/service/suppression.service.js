'use strict';

const crypto = require('crypto');
const sequelize = require('../../../config/db.js');
const {
  User, Owner, OwnerMember, Tenant, Lease, DeviceToken,
} = require('../../../models/index.js');
const { bcryptConfig } = require('../../../config/security.js');
const bcrypt = require('../../../utils/motDePasse.js');
const { ConflictError, ForbiddenError } = require('../../../errors/AppError.js');
const sessions = require('../../auth/service/session.service.js');
const mfa = require('../../auth/service/mfa.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const droits = require('../../abonnement/service/droits.service.js');
const storage = require('../../../infrastructure/storage.service.js');
const logger = require('../../../utils/logger.js');

/**
 * Suppression de compte à la demande de l'utilisateur (constat M4 de l'audit —
 * loi sénégalaise 2008-12 sur les données personnelles, RGPD par analogie).
 *
 * Le compte est ANONYMISÉ, pas effacé : les pièces comptables (loyers,
 * quittances, caisse, journal d'audit) restent attachées à un identifiant
 * neutre pendant les 10 ans de conservation légale. Ce qui disparaît :
 * l'identité (nom, e-mail, téléphone, photo de profil), le mot de passe, la
 * double authentification, les sessions et les appareils.
 *
 *   - locataire : la fiche tenue par le bailleur demeure (elle lui appartient,
 *     comme le bail) ; elle est détachée du compte supprimé ;
 *   - propriétaire titulaire : refus tant qu'un bail est ACTIF (les locataires
 *     dépendent de l'espace) ; sinon l'espace est suspendu et conservé pour la
 *     durée légale ;
 *   - membre d'un espace : son appartenance est désactivée ;
 *   - super administrateur : jamais par cette voie.
 */
async function supprimerCompte(acteur, { current_password: motDePasse, code, code_secours: codeSecours }) {
  if (acteur.role_code === 'super_admin') {
    throw new ForbiddenError('Un compte super administrateur se retire par un autre super administrateur.', 'SUPPRESSION_INTERDITE');
  }
  const user = await mfa.exigerReauthentification(acteur.id, { current_password: motDePasse, code, code_secours: codeSecours });

  const espace = await Owner.findOne({ where: { user_id: user.id }, attributes: ['id'] });
  if (espace) {
    const actifs = await Lease.count({ where: { owner_id: espace.id, status: 'actif' } });
    if (actifs) {
      throw new ConflictError(
        `Vous avez ${actifs} bail${actifs > 1 ? 's' : ''} actif${actifs > 1 ? 's' : ''} : terminez-les avant de supprimer votre compte.`,
        'BAUX_ACTIFS', { baux_actifs: actifs }
      );
    }
  }

  // Empreinte d'un secret aléatoire jamais conservé : plus aucune connexion possible.
  const empreinte = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), bcryptConfig.saltRounds);
  await sequelize.transaction(async (t) => {
    await sessions.revoquerToutesLesSessions(user.id, t, 'globale');
    await DeviceToken.destroy({ where: { user_id: user.id }, transaction: t });
    if (espace) {
      await Owner.update({ status: 'suspendu' }, { where: { id: espace.id }, transaction: t });
    }
    await OwnerMember.update({ status: 'inactif' }, { where: { user_id: user.id }, transaction: t });
    await Tenant.update({ user_id: null }, { where: { user_id: user.id }, transaction: t });
    await User.update({
      first_name: 'Compte',
      last_name: 'supprimé',
      // Contrainte « e-mail OU téléphone » : adresse neutre, non routable (RFC 2606).
      email: `supprime-${user.id}@anonyme.invalid`,
      email_verified_at: null,
      phone: null,
      phone_verified_at: null,
      password_hash: empreinte,
      status: 'inactif',
      totp_secret: null,
      totp_enabled_at: null,
      totp_last_step: null,
      mfa_recovery_codes: [],
      avatar_key: null,
      avatar_updated_at: null,
      anonymized_at: new Date(),
    }, { where: { id: user.id }, transaction: t });
    await User.destroy({ where: { id: user.id }, transaction: t });
    await journaliser({
      action: 'compte.suppression', entityType: 'user', entityId: user.id, ownerId: espace?.id || null,
      acteur: { id: user.id, role_code: user.role_code },
      details: { role: user.role_code, espace_suspendu: Boolean(espace) },
    }, t);
  });
  if (espace) await droits.invalider(espace.id).catch(() => {});
  // Photo de profil : effacée du stockage APRÈS la transaction validée.
  if (user.avatar_key) {
    await storage.supprimer(user.avatar_key).catch((err) => logger.warn('[compte] Photo de profil non supprimée', { error: err.message }));
  }
}

module.exports = { supprimerCompte };
