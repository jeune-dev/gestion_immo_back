'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { PhoneVerification } = require('../../../models/index.js');
const whatsapp = require('../../../infrastructure/whatsapp.service.js');
const { empreinteOtp, genererCode } = require('../../../utils/otp.js');
const { comparerTempsConstant } = require('../../../infrastructure/paiement/signature.js');
const { BadRequestError, ServiceIndisponibleError } = require('../../../errors/AppError.js');
const logger = require('../../../utils/logger.js');

/**
 * Vérification du téléphone par code WhatsApp (constat E2 de l'audit).
 *
 * Le téléphone est l'identifiant de connexion ET le destinataire des
 * invitations locataire : sans preuve de possession, n'importe qui pouvait
 * créer un compte au numéro d'un tiers et capter ensuite ses invitations.
 *
 * Code à 6 chiffres, 10 minutes, 5 essais, usage unique ; seule l'empreinte
 * HMAC (OTP_SECRET) est stockée. Le débit d'envoi est plafonné par IP ET par
 * numéro ciblé (otpCibleRateLimit) : pas de « bombardement » WhatsApp.
 */

const DUREE_MINUTES = 10;
const ESSAIS_MAX = 5;
const contexte = (phone, purpose) => `${purpose}:${phone}`;
const refus = () => new BadRequestError('Code de vérification invalide ou expiré. Demandez un nouveau code.', 'CODE_TELEPHONE_INVALIDE');

/**
 * Émet un code et l'envoie par WhatsApp. La réponse ne dit rien de
 * l'existence d'un compte pour ce numéro (anti-énumération).
 */
async function envoyerCode(phone, purpose = 'inscription') {
  if (!whatsapp.estConfigure() && process.env.NODE_ENV === 'production') {
    throw new ServiceIndisponibleError("La vérification du numéro par WhatsApp n'est pas disponible pour le moment. Réessayez plus tard.", 'WHATSAPP_INDISPONIBLE');
  }

  const code = genererCode(6);
  await sequelize.transaction(async (t) => {
    // Un seul code valide à la fois par numéro et par usage.
    await PhoneVerification.update({ used_at: new Date() }, { where: { phone, purpose, used_at: null }, transaction: t });
    await PhoneVerification.create({
      phone, purpose,
      code_hash: empreinteOtp(contexte(phone, purpose), code),
      expires_at: new Date(Date.now() + DUREE_MINUTES * 60 * 1000),
    }, { transaction: t });
  });

  try {
    await whatsapp.envoyerCode({ telephone: phone, code });
  } catch (err) {
    logger.warn('[verification-telephone] Envoi WhatsApp impossible', { error: err.message });
    throw new ServiceIndisponibleError("Le code n'a pas pu être envoyé par WhatsApp. Vérifiez le numéro (compte WhatsApp actif) et réessayez.", 'WHATSAPP_ECHEC');
  }
  return { minutes: DUREE_MINUTES };
}

/**
 * Vérifie ET consomme le code. L'essai est compté AVANT la comparaison par une
 * mise à jour conditionnelle (pas de course entre requêtes simultanées), dans
 * sa propre transaction validée : un refus ultérieur n'annule pas le décompte.
 */
async function verifierCode(phone, code, purpose = 'inscription') {
  if (!phone || !/^\d{6}$/.test(String(code || ''))) throw refus();
  const demande = await PhoneVerification.findOne({
    where: { phone, purpose, used_at: null, expires_at: { [Op.gt]: new Date() } },
    order: [['created_at', 'DESC']],
  });
  if (!demande) throw refus();

  const [comptes] = await sequelize.query(
    `UPDATE phone_verifications SET attempts = attempts + 1
      WHERE id = :id AND used_at IS NULL AND attempts < :max RETURNING attempts`,
    { replacements: { id: demande.id, max: ESSAIS_MAX } }
  );
  if (!comptes.length) throw refus();
  if (!comparerTempsConstant(empreinteOtp(contexte(phone, purpose), String(code)), demande.code_hash)) throw refus();

  const [consomme] = await PhoneVerification.update({ used_at: new Date() }, { where: { id: demande.id, used_at: null } });
  if (!consomme) throw refus();
  return true;
}

/** Purge des codes expirés depuis plus d'un jour (appelée par la tâche de rétention). */
async function purgerExpires() {
  return PhoneVerification.destroy({ where: { expires_at: { [Op.lt]: new Date(Date.now() - 24 * 3600 * 1000) } } });
}

module.exports = { envoyerCode, verifierCode, purgerExpires, DUREE_MINUTES, ESSAIS_MAX };
