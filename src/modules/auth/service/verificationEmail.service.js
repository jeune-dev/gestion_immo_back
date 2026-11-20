'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { User, EmailVerification } = require('../../../models/index.js');
const { jwtConfig, verificationEmailInscription } = require('../../../config/security.js');
const { ConflictError, BadRequestError } = require('../../../errors/AppError.js');
const parametres = require('../../parametres/service/parametres.service.js');
const email = require('../../../infrastructure/email.service.js');
const logger = require('../../../utils/logger.js');
const { comparerTempsConstant } = require('../../../infrastructure/paiement/signature.js');

/**
 * Vérification de l'adresse e-mail AVANT la création du compte (§ 5).
 *
 * L'ordre compte : le code est vérifié, PUIS le compte est créé. Une adresse
 * inscrite est donc une adresse qui existe et que la personne relève — sans
 * compte « en attente de confirmation » qui encombrerait la base et bloquerait
 * l'adresse. La preuve de la vérification voyage dans un jeton court remis au
 * client, que l'inscription présente : le serveur ne se fie jamais au client
 * pour dire qu'une adresse a été vérifiée.
 *
 * Le code n'est jamais stocké en clair (empreinte HMAC), les essais sont
 * comptés AVANT la comparaison (même garde que `password_resets` contre les
 * requêtes simultanées), et la durée comme le nombre d'essais viennent du
 * paramètre `otp` de la plateforme.
 */

const LONGUEUR_CODE = 6;
const DUREE_JETON = '20m';

const normaliser = (adresse) => String(adresse || '').trim().toLowerCase();

/** Code à 6 chiffres, zéros de tête compris (`048213` est un code valide). */
const genererCode = () => String(crypto.randomInt(0, 10 ** LONGUEUR_CODE)).padStart(LONGUEUR_CODE, '0');

const empreinteCode = (adresse, code) => crypto
  .createHmac('sha256', jwtConfig.secret)
  .update(`${normaliser(adresse)}:${String(code || '').trim()}`)
  .digest('hex');

// Clé DÉRIVÉE : un jeton « inscription » ne peut pas servir de jeton d'accès,
// même si la vérification du type était oubliée ailleurs.
const cleJeton = () => crypto.createHmac('sha256', jwtConfig.secret).update('jeton-verification-email').digest();

const REFUS = () => new BadRequestError(
  'Code incorrect ou expiré. Vérifiez-le ou demandez-en un nouveau.',
  'CODE_INVALIDE'
);

/** Un compte porte-t-il déjà cette adresse ? */
async function adresseDejaPrise(adresse) {
  const existe = await User.findOne({
    where: sequelize.where(sequelize.fn('lower', sequelize.col('email')), normaliser(adresse)),
    attributes: ['id'],
  });
  return Boolean(existe);
}

/**
 * Étape 1 : envoie un code à l'adresse. Les demandes précédentes pour cette
 * adresse sont closes — un seul code vivant à la fois.
 * @returns {Promise<{ minutes: number }>} durée de validité, pour l'écran de saisie
 */
async function demanderCode({ email: adresse, prenom }) {
  const cible = normaliser(adresse);
  if (await adresseDejaPrise(cible)) {
    throw new ConflictError('Cet e-mail est déjà utilisé', 'COMPTE_EXISTANT');
  }

  const { duree_minutes: minutes } = await parametres.plateforme('otp');
  const code = genererCode();
  await sequelize.transaction(async (t) => {
    await EmailVerification.update(
      { used_at: new Date() },
      { where: { email: cible, used_at: null }, transaction: t }
    );
    await EmailVerification.create({
      email: cible,
      code_hash: empreinteCode(cible, code),
      expires_at: new Date(Date.now() + minutes * 60 * 1000),
    }, { transaction: t });
  });

  try {
    await email.envoyerCodeInscription({ email: cible, prenom, code, minutes });
  } catch (err) {
    // L'envoi peut échouer (fournisseur indisponible) : la demande reste
    // valable et l'écran propose de renvoyer le code.
    logger.warn('[auth] Envoi du code d’inscription impossible', { error: err.message });
  }
  return { minutes };
}

/**
 * Étape 2 : contrôle le code et délivre le jeton que l'inscription présentera.
 * @returns {Promise<{ jeton: string }>}
 */
async function verifierCode({ email: adresse, code }) {
  const cible = normaliser(adresse);
  const { tentatives_max: maxEssais } = await parametres.plateforme('otp');

  const demande = await EmailVerification.findOne({
    where: { email: cible, used_at: null, expires_at: { [Op.gt]: new Date() } },
    order: [['created_at', 'DESC']],
  });
  if (!demande) throw REFUS();

  // Essai compté par une mise à jour conditionnelle UNIQUE : deux requêtes
  // simultanées ne peuvent pas se partager le même essai.
  const [comptes] = await sequelize.query(
    `UPDATE email_verifications SET attempts = attempts + 1
      WHERE id = :id AND used_at IS NULL AND attempts < :max RETURNING attempts`,
    { replacements: { id: demande.id, max: maxEssais } }
  );
  if (!comptes.length) {
    throw new BadRequestError('Trop d’essais pour ce code. Demandez-en un nouveau.', 'CODE_EPUISE');
  }
  if (!comparerTempsConstant(empreinteCode(cible, code), demande.code_hash)) throw REFUS();

  await demande.update({ verified_at: new Date() });
  const jeton = jwt.sign(
    { email: cible, vid: demande.id, typ: 'inscription' },
    cleJeton(),
    { expiresIn: DUREE_JETON, algorithm: jwtConfig.algorithme }
  );
  return { jeton };
}

/**
 * Étape 3, au moment de créer le compte : le jeton prouve que CETTE adresse a
 * été vérifiée, et il ne sert qu'une fois. Sans la vérification activée, ne
 * fait rien — une ancienne version de l'application s'inscrit comme avant.
 */
/**
 * @param {object} options
 * @param {string} options.email adresse que le jeton doit couvrir
 * @param {string} [options.jeton] preuve remise à l'étape 2
 * @param {import('sequelize').Transaction} [options.transaction] celle qui crée
 *   le compte. À fournir : sans elle, un échec de création laisserait le jeton
 *   consommé pour un compte qui n'existe pas, et l'utilisateur devrait tout
 *   reprendre depuis l'envoi du code.
 */
async function consommerJeton({ email: adresse, jeton, transaction }) {
  if (!verificationEmailInscription) return;

  const manquant = new BadRequestError(
    'Adresse e-mail non vérifiée. Reprenez l’inscription pour recevoir un code.',
    'EMAIL_NON_VERIFIE'
  );
  if (!jeton) throw manquant;

  let contenu;
  try {
    contenu = jwt.verify(String(jeton), cleJeton(), { algorithms: [jwtConfig.algorithme] });
  } catch {
    throw manquant;
  }
  if (contenu.typ !== 'inscription' || contenu.email !== normaliser(adresse)) throw manquant;

  // Consommation conditionnelle : un jeton vérifié ne crée qu'un seul compte,
  // même si deux requêtes partent en même temps.
  const [lignes] = await sequelize.query(
    `UPDATE email_verifications SET used_at = now()
      WHERE id = :id AND used_at IS NULL AND verified_at IS NOT NULL RETURNING id`,
    { replacements: { id: contenu.vid }, transaction }
  );
  if (!lignes.length) throw manquant;
}

module.exports = { demanderCode, verifierCode, consommerJeton, adresseDejaPrise };
