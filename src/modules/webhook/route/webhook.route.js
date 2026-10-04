'use strict';

const router = require('express').Router();
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const validate = require('../../../middlewares/validate.middleware.js');
const { paramId } = require('../../../validations/common.js');
const { BadRequestError, ForbiddenError } = require('../../../errors/AppError.js');
const S = require('../service/webhook.service.js');
const { comparerTempsConstant } = require('../../../infrastructure/paiement/signature.js');
const abonnement = require('../../abonnement/service/abonnement.service.js');

/**
 * Webhooks publics (routes.js : limite de débit dédiée, aucun jeton).
 * Les corps signés sont lus sur `req.rawBody`, capturé par app.js AVANT le
 * parsing JSON : re-sérialiser `req.body` produirait d'autres octets et une
 * signature toujours invalide (bug documenté dans Widjila).
 */

const exigerCorpsBrut = (req) => {
  if (!req.rawBody) throw new BadRequestError('Corps de notification absent', 'CORPS_ABSENT');
  return req.rawBody;
};

// § 51 — IPN PayDunya (Wave / Orange Money via agrégateur) pour un propriétaire.
// Corps x-www-form-urlencoded ; son contenu n'est pas cru, la facture est relue.
router.post('/paydunya/:id', validate(paramId, 'params'), asyncHandler(async (req, res) => {
  const resultat = await S.paydunyaIpn(req.params.id, req.body);
  res.json({ success: true, message: 'Notification traitée', data: resultat });
}));

// § 51 — Wave Checkout direct pour un propriétaire.
router.post('/wave/:id', validate(paramId, 'params'), asyncHandler(async (req, res) => {
  const resultat = await S.waveEvenement(req.params.id, exigerCorpsBrut(req), req.headers['wave-signature']);
  res.json({ success: true, message: 'Notification traitée', data: resultat });
}));

// § 31 — IPN PayDunya du paiement d'un abonnement (identifiants de la plateforme).
router.post('/abonnement/paydunya', asyncHandler(async (req, res) => {
  const resultat = await abonnement.traiterIpnPaydunya(req.body);
  if (!resultat.ok) throw new BadRequestError('Notification refusée', 'NOTIFICATION_REFUSEE');
  res.json({ success: true, message: 'Notification traitée' });
}));

// § 54.3 — WhatsApp Cloud API : vérification de l'abonnement au webhook…
router.get('/whatsapp', (req, res, next) => {
  const jeton = process.env.WHATSAPP_VERIFY_TOKEN;
  const recu = String(req.query['hub.verify_token'] || '');
  // Comparaison à temps constant sur les OCTETS (des caractères multi-octets de
  // même longueur en caractères faisaient lever timingSafeEqual → 500).
  const valide = Boolean(jeton) && comparerTempsConstant(jeton, recu);
  if (req.query['hub.mode'] !== 'subscribe' || !valide) return next(new ForbiddenError('Vérification refusée', 'VERIFICATION_REFUSEE'));
  return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
});

// … et statuts de livraison des messages.
router.post('/whatsapp', asyncHandler(async (req, res) => {
  const resultat = await S.whatsappStatuts(exigerCorpsBrut(req), req.headers['x-hub-signature-256']);
  res.json({ success: true, message: 'Statuts enregistrés', data: resultat });
}));

module.exports = router;
