'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  User, Owner, OwnerMember, Subscription, SubscriptionPlan, PasswordReset, Tenant, TenantInvitation,
} = require('../../../models/index.js');
const { bcryptConfig, validerMotDePasseAdmin } = require('../../../config/security.js');
const bcrypt = require('../../../utils/motDePasse.js');
const { normaliserTelephone } = require('../../../utils/telephone.js');
const { aujourdhui, ajouterJours } = require('../../../utils/dates.js');
const { ConflictError, UnauthorizedError, ForbiddenError, BadRequestError, ValidationError } = require('../../../errors/AppError.js');
const sessions = require('./session.service.js');
const invitations = require('./invitation.service.js');
const mfa = require('./mfa.service.js');
const verrouillage = require('./verrouillage.service.js');
const parametres = require('../../parametres/service/parametres.service.js');
const email = require('../../../infrastructure/email.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const logger = require('../../../utils/logger.js');
const { comparerTempsConstant } = require('../../../infrastructure/paiement/signature.js');

// Empreinte bcrypt factice (même coût que les vraies) : égalise le temps de
// réponse quand le compte n'existe pas (anti-énumération par chronométrage,
// reprise de Widjila). Calculée une fois, au premier besoin.
let empreinteFactice = null;
const EMPREINTE_FACTICE = () => {
  empreinteFactice ||= bcrypt.hash(crypto.randomBytes(16).toString('hex'), bcryptConfig.saltRounds);
  return empreinteFactice;
};

// Réponse identique pour « compte inconnu » et « mauvais mot de passe ». Le
// blocage temporaire, lui, est annoncé avec son délai réel
// (verrouillage.service) ; « mot de passe oublié » le lève.
const MESSAGE_ECHEC = 'Identifiant ou mot de passe incorrect.';

/** Prévient quand le prochain essai faux va bloquer le compte. */
const messageEchec = (essaisRestants) => (essaisRestants <= 2
  ? `${MESSAGE_ECHEC} Attention : encore ${essaisRestants} essai${essaisRestants > 1 ? 's' : ''} avant un blocage temporaire du compte.`
  : MESSAGE_ECHEC);

/**
 * Traçage des connexions dans le journal d'audit (constat M9) : réussites et
 * échecs, avec le MOTIF de l'échec. L'identifiant tenté n'est jamais écrit en
 * clair (empreinte courte : regroupe les essais sur un même compte sans
 * constituer une liste d'adresses) ; l'IP et le navigateur viennent du
 * contexte de la requête.
 */
const empreinteIdentifiant = (identifiant) => crypto.createHash('sha256')
  .update(String(identifiant || '').trim().toLowerCase()).digest('hex').slice(0, 16);

async function tracerConnexion(action, { user = null, identifiant, motif = null } = {}) {
  await journaliser({
    action,
    entityType: 'user',
    entityId: user?.id || null,
    // Un échec n'est pas imputé au titulaire du compte : l'auteur est inconnu.
    acteur: action === 'compte.connexion' ? user : { id: null, role_code: 'anonyme' },
    details: { ...(motif ? { motif } : {}), identifiant_empreinte: empreinteIdentifiant(identifiant) },
  }).catch((err) => logger.warn('[auth] Traçage de connexion impossible', { error: err.message }));
}

/** E-mail ou téléphone → clause de recherche d'utilisateur. */
function critereIdentifiant(identifiant) {
  const brut = String(identifiant || '').trim();
  // Motif ANCRÉ et borné (pas de retour arrière quadratique).
  if (/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(brut)) {
    return sequelize.where(sequelize.fn('lower', sequelize.col('email')), brut.toLowerCase());
  }
  const tel = normaliserTelephone(brut);
  return tel ? { phone: tel } : null;
}

/**
 * Inscription d'un propriétaire (§ 5) : compte, espace propriétaire,
 * appartenance et abonnement d'essai (§ 31) dans UNE transaction.
 */
async function inscrireProprietaire(donnees, meta) {
  const existe = await User.findOne({
    where: { [Op.or]: [sequelize.where(sequelize.fn('lower', sequelize.col('email')), donnees.email), { phone: donnees.phone }] },
    attributes: ['id', 'email', 'phone'],
  });
  if (existe) {
    throw new ConflictError(
      existe.phone === donnees.phone ? 'Ce numéro de téléphone est déjà utilisé' : 'Cet e-mail est déjà utilisé',
      'COMPTE_EXISTANT'
    );
  }

  const empreinte = await bcrypt.hash(donnees.password, bcryptConfig.saltRounds);
  const essai = await parametres.plateforme('essai');

  return sequelize.transaction(async (t) => {
    const user = await User.create({
      role_code: 'proprietaire',
      first_name: donnees.first_name,
      last_name: donnees.last_name,
      email: donnees.email,
      phone: donnees.phone,
      password_hash: empreinte,
    }, { transaction: t });

    const owner = await Owner.create({
      user_id: user.id,
      display_name: `${donnees.first_name} ${donnees.last_name}`,
      company_name: donnees.company_name || null,
      phone: donnees.phone,
      email: donnees.email,
      city: donnees.city || null,
    }, { transaction: t });

    await OwnerMember.create({ owner_id: owner.id, user_id: user.id, role_code: 'proprietaire' }, { transaction: t });

    const plan = await SubscriptionPlan.findOne({ where: { code: essai.plan_code, status: 'actif' }, transaction: t });
    if (plan && essai.duree_jours > 0) {
      const debut = aujourdhui();
      const fin = ajouterJours(debut, essai.duree_jours);
      await Subscription.create({
        owner_id: owner.id, plan_id: plan.id, status: 'essai',
        current_period_start: debut, current_period_end: fin, trial_ends_at: fin,
      }, { transaction: t });
    } else {
      logger.warn('[auth] Plan d’essai introuvable ou essai désactivé — espace créé sans abonnement', { plan: essai.plan_code });
    }

    await journaliser({
      action: 'compte.creation', entityType: 'user', entityId: user.id, ownerId: owner.id,
      acteur: user, details: { role: 'proprietaire', plan_essai: plan?.code || null },
    }, t);

    const session = await sessions.ouvrirSession(user, meta, t);
    return { user, owner, session };
  });
}

/**
 * Connexion par téléphone ou e-mail (§ 5), avec verrouillage après échecs
 * successifs (§ 32 anti force brute) et réponses indiscernables pour un compte
 * inexistant.
 */
async function connecter({ identifiant, password }, meta) {
  const critere = critereIdentifiant(identifiant);
  const user = critere ? await User.findOne({ where: critere }) : null;

  if (!user) {
    await bcrypt.compare(password, await EMPREINTE_FACTICE());
    await tracerConnexion('compte.connexion_echec', { identifiant, motif: 'compte_inconnu' });
    throw new UnauthorizedError(MESSAGE_ECHEC, 'IDENTIFIANTS_INVALIDES');
  }

  if (verrouillage.secondesRestantes(user) > 0) {
    await tracerConnexion('compte.connexion_echec', { user, identifiant, motif: 'compte_verrouille' });
    verrouillage.verifierNonBloque(user);
  }

  const valide = await bcrypt.compare(password, user.password_hash);
  if (!valide) {
    await tracerConnexion('compte.connexion_echec', { user, identifiant, motif: 'mot_de_passe' });
    const { essaisRestants } = await verrouillage.enregistrerEchec(user, 'echecs_successifs');
    throw new UnauthorizedError(messageEchec(essaisRestants), 'IDENTIFIANTS_INVALIDES');
  }

  // Statut annoncé seulement à qui connaît le mot de passe (anti-énumération).
  if (user.status !== 'actif') throw new ForbiddenError('Votre compte est désactivé. Contactez le support.', 'COMPTE_INACTIF');

  // Double authentification active : le mot de passe seul n'ouvre PAS de
  // session, seulement l'étape « code » (POST /auth/mfa). Le compteur d'échecs
  // n'est PAS remis à zéro ici : sinon, qui connaît le mot de passe pourrait
  // alterner connexion et codes faux sans jamais être verrouillé.
  if (mfa.mfaActive(user)) {
    await tracerConnexion('compte.connexion_mot_de_passe_valide', { user, identifiant, motif: 'double_authentification_requise' });
    return { user, mfa: { jeton: mfa.emettreJetonMfa(user), expiresIn: mfa.DUREE_JETON_MFA } };
  }

  await verrouillage.reinitialiser(user);
  const session = await sessions.ouvrirSession(user, meta);
  await tracerConnexion('compte.connexion', { user, identifiant });
  return { user, session };
}

/**
 * Code de réinitialisation : 8 caractères (lettres majuscules et chiffres, comme
 * Yobante), tirés sans biais. Stocké en empreinte HMAC liée au compte.
 */
const ALPHABET_CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const genererCode = () => Array.from({ length: 8 }, () => ALPHABET_CODE[crypto.randomInt(ALPHABET_CODE.length)]).join('');
const empreinteCode = (userId, code) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${userId}:${code}`).digest('hex');

/**
 * Mot de passe oublié (§ 5), étape 1 : code envoyé par e-mail, valable la
 * durée du paramètre `otp` (15 minutes par défaut). Réponse identique que le
 * compte existe ou non. Une nouvelle demande annule le code précédent.
 *
 * Super admin : réinitialisation par e-mail autorisée (comme Yobante) ; sa
 * double authentification est supprimée au changement de mot de passe et
 * devra être reconfigurée à la connexion suivante.
 */
async function demanderReinitialisation({ identifiant }) {
  const critere = critereIdentifiant(identifiant);
  const user = critere ? await User.findOne({ where: critere, attributes: ['id', 'email', 'first_name', 'status', 'role_code'] }) : null;
  if (!user || user.status !== 'actif' || !user.email) return;

  const { duree_minutes: minutes } = await parametres.plateforme('otp');
  const code = genererCode();
  await sequelize.transaction(async (t) => {
    await PasswordReset.update({ used_at: new Date() }, { where: { user_id: user.id, used_at: null }, transaction: t });
    await PasswordReset.create({
      user_id: user.id,
      otp_hash: empreinteCode(user.id, code),
      expires_at: new Date(Date.now() + minutes * 60 * 1000),
    }, { transaction: t });
  });
  if (user.role_code === 'super_admin') {
    await journaliser({ action: 'compte.reinitialisation_demandee', entityType: 'user', entityId: user.id, acteur: { id: null, role_code: 'anonyme' }, details: { role: 'super_admin' } });
  }
  try {
    await email.envoyerCodeReinitialisation({ email: user.email, prenom: user.first_name, code, minutes });
  } catch (err) {
    logger.warn('[auth] Envoi du code de réinitialisation impossible', { error: err.message });
  }
}

/**
 * Contrôle d'un code reçu : compte actif, demande en cours, essai compté
 * AVANT la comparaison (constat E2 : une mise à jour conditionnelle unique,
 * sinon des requêtes simultanées multipliaient les essais sur un même code).
 * @returns {Promise<{ user, demande }>}
 */
async function controlerCode({ identifiant, code }) {
  const critere = critereIdentifiant(identifiant);
  const user = critere ? await User.findOne({ where: critere }) : null;
  const refus = new BadRequestError('Code incorrect ou expiré. Vérifiez-le ou demandez-en un nouveau.', 'CODE_INVALIDE');
  if (!user || user.status !== 'actif') throw refus;

  const { tentatives_max: maxEssais } = await parametres.plateforme('otp');
  const demande = await PasswordReset.findOne({
    where: { user_id: user.id, used_at: null, expires_at: { [Op.gt]: new Date() } },
    order: [['created_at', 'DESC']],
  });
  if (!demande) throw refus;

  const [comptes] = await sequelize.query(
    `UPDATE password_resets SET attempts = attempts + 1
      WHERE id = :id AND used_at IS NULL AND attempts < :max RETURNING attempts`,
    { replacements: { id: demande.id, max: maxEssais } }
  );
  if (!comptes.length) {
    throw new BadRequestError('Trop d’essais pour ce code. Demandez-en un nouveau.', 'CODE_EPUISE');
  }
  if (!comparerTempsConstant(empreinteCode(user.id, code), demande.otp_hash)) throw refus;
  return { user, demande };
}

/** Étape 2 : vérifie le code sans le consommer (avant de choisir le nouveau mot de passe). */
async function verifierCodeReinitialisation(donnees) {
  await controlerCode(donnees);
}

/** Étape 3 : nouveau mot de passe ; le code est consommé et toutes les sessions tombent. */
async function reinitialiserMotDePasse({ identifiant, code, password }) {
  const { user, demande } = await controlerCode({ identifiant, code });

  const superAdmin = user.role_code === 'super_admin';
  // Politique renforcée du super admin, contrôlée APRÈS le code (sinon un
  // mot de passe refusé révélerait qu'un identifiant est celui d'un super
  // admin). Le code n'est pas consommé : l'utilisateur en choisit un autre.
  if (superAdmin) {
    const erreur = validerMotDePasseAdmin(password, user.email);
    if (erreur) throw new ValidationError('Données invalides', [erreur], 'MOT_DE_PASSE_TROP_FAIBLE');
  }
  const empreinte = await bcrypt.hash(password, bcryptConfig.saltRounds);
  await sequelize.transaction(async (t) => {
    // Consommation conditionnelle : un code ne sert qu'une fois, même sous concurrence.
    const [consomme] = await PasswordReset.update(
      { used_at: new Date() },
      { where: { id: demande.id, used_at: null }, transaction: t }
    );
    if (!consomme) throw new BadRequestError('Code incorrect ou expiré. Vérifiez-le ou demandez-en un nouveau.', 'CODE_INVALIDE');
    await user.update({
      password_hash: empreinte,
      failed_login_attempts: 0,
      locked_until: null,
      must_change_password: false,
      // Super admin : double authentification à reconfigurer (le code e-mail a suffi).
      ...(superAdmin ? { totp_secret: null, totp_enabled_at: null, totp_last_step: null, mfa_recovery_codes: [] } : {}),
    }, { transaction: t });
    // Toutes les sessions tombent : un voleur de session perd l'accès.
    await sessions.revoquerToutesLesSessions(user.id, t);
    await journaliser({
      action: 'compte.reinitialisation_mot_de_passe', entityType: 'user', entityId: user.id, acteur: user,
      details: superAdmin ? { double_authentification_reinitialisee: true } : undefined,
    }, t);
  });
}

/**
 * Activation du compte locataire (§ 5 option B) par lien OU par code + téléphone.
 *
 * Si le téléphone correspond déjà à un compte LOCATAIRE (il loue chez un autre
 * propriétaire), la fiche lui est rattachée — à condition que le mot de passe
 * fourni soit celui de ce compte (preuve de possession). Un compte d'un autre
 * rôle portant ce numéro bloque l'activation.
 */
async function activerLocataire({ token, code, phone, password }, meta) {
  const refus = () => new BadRequestError("Invitation invalide, expirée ou déjà utilisée", 'INVITATION_INVALIDE');

  // CORRECTIF (force brute du code à 8 chiffres, § 32). La recherche de
  // l'invitation — et donc l'incrément du compteur d'essais en cas de code
  // faux — se fait dans SA PROPRE transaction, VALIDÉE avant de répondre.
  // Auparavant elle partageait la transaction de l'activation : le refus
  // INVITATION_INVALIDE annulait aussi l'incrément, et le plafond de 5 essais
  // ne s'appliquait jamais.
  const invitationId = await sequelize.transaction(async (t) => {
    if (token) return (await invitations.parJeton(token, t))?.id || null;
    const fiches = await Tenant.findAll({ where: { phone, user_id: null }, attributes: ['id'], transaction: t });
    return (await invitations.parCode(fiches.map((f) => f.id), code, t))?.id || null;
  });
  if (!invitationId) throw refus();

  try {
    return await activerAvecInvitation(invitationId, { token, password }, meta, refus);
  } catch (err) {
    // Mot de passe du compte existant erroné : l'essai est décompté sur
    // l'invitation (hors de la transaction annulée). Sans cela, quiconque
    // connaît le code — le bailleur lui-même — pourrait deviner sans limite
    // le mot de passe du compte locataire déjà ouvert chez un autre bailleur.
    if (err.code === 'COMPTE_EXISTANT_MOT_DE_PASSE') {
      await TenantInvitation.increment('attempts', { where: { id: invitationId } });
    }
    throw err;
  }
}

async function activerAvecInvitation(invitationId, { token, password }, meta, refus) {
  return sequelize.transaction(async (t) => {
    // Relue sous verrou : une activation concurrente avec la même invitation
    // l'a peut-être consommée entre-temps.
    const invitation = await TenantInvitation.findByPk(invitationId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!invitations.estValide(invitation)) throw refus();

    const tenant = await Tenant.findByPk(invitation.tenant_id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!tenant || tenant.user_id) throw new ConflictError('Ce locataire a déjà activé son compte', 'DEJA_ACTIVE');

    let user = await User.findOne({ where: { phone: tenant.phone }, transaction: t });
    if (user) {
      if (user.role_code !== 'locataire') throw new ConflictError('Ce numéro est déjà associé à un autre type de compte', 'TELEPHONE_UTILISE');
      if (!(await bcrypt.compare(password, user.password_hash))) {
        throw new UnauthorizedError('Un compte existe déjà pour ce numéro : saisissez son mot de passe pour y rattacher ce logement.', 'COMPTE_EXISTANT_MOT_DE_PASSE');
      }
      if (user.status !== 'actif') throw new ForbiddenError('Votre compte est désactivé. Contactez le support.', 'COMPTE_INACTIF');
    } else {
      const emailLibre = tenant.email
        ? !(await User.findOne({ where: sequelize.where(sequelize.fn('lower', sequelize.col('email')), tenant.email.toLowerCase()), transaction: t }))
        : false;
      user = await User.create({
        role_code: 'locataire',
        first_name: tenant.first_name,
        last_name: tenant.last_name,
        phone: tenant.phone,
        email: emailLibre ? tenant.email : null,
        password_hash: await bcrypt.hash(password, bcryptConfig.saltRounds),
      }, { transaction: t });
    }

    await tenant.update({ user_id: user.id }, { transaction: t });
    await TenantInvitation.update({ used_at: new Date() }, { where: { id: invitation.id }, transaction: t });
    await journaliser({
      action: 'locataire.activation_compte', entityType: 'tenant', entityId: tenant.id,
      ownerId: tenant.owner_id, acteur: user, details: { mode: token ? 'lien' : 'code' },
    }, t);

    const session = await sessions.ouvrirSession(user, meta, t);
    return { user, session };
  });
}

module.exports = {
  inscrireProprietaire, connecter, demanderReinitialisation, verifierCodeReinitialisation, reinitialiserMotDePasse, activerLocataire, critereIdentifiant,
};
