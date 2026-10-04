'use strict';

const { PaymentProvider, PaymentTransaction, MessageDelivery } = require('../../../models/index.js');
const paydunya = require('../../../infrastructure/paiement/paydunya.provider.js');
const wave = require('../../../infrastructure/paiement/wave.provider.js');
const whatsapp = require('../../../infrastructure/whatsapp.service.js');
const rapprochement = require('../../paiement/service/rapprochement.service.js');
const { UnauthorizedError, NotFoundError, ServiceIndisponibleError } = require('../../../errors/AppError.js');
const logger = require('../../../utils/logger.js');

/**
 * Webhooks des fournisseurs (§ 51, § 54.3).
 *
 * Aucune authentification par jeton : l'AUTHENTICITÉ vient de la SIGNATURE
 * (Wave, WhatsApp) ou de la RELECTURE chez le fournisseur (PayDunya), avec les
 * secrets du propriétaire concerné (désigné par l'identifiant de son moyen de
 * paiement dans l'URL). Une notification non authentique est refusée sans
 * rien toucher.
 */

async function moyenIntegre(id, provider) {
  const moyen = await PaymentProvider.findByPk(id);
  if (!moyen || moyen.provider !== provider || moyen.mode !== 'integre') throw new NotFoundError('Moyen de paiement introuvable');
  return moyen;
}

/**
 * Relit une IPN PayDunya auprès de PayDunya (voir paydunya.provider.js) :
 * empreinte de la clé principale, puis statut / montant / référence lus sur la
 * facture elle-même — jamais dans le corps de l'IPN.
 */
async function verifierIpnPaydunya(identifiants, corps, contexte) {
  let evt;
  try {
    evt = await paydunya.verifierIpn(identifiants, corps);
  } catch (err) {
    // PayDunya injoignable : la notification n'est pas acquittée (503) pour
    // être renvoyée ; la transaction reste « en attente », rien n'est perdu.
    logger.warn('[webhook] Relecture de la facture PayDunya impossible', { ...contexte, error: err.message });
    throw new ServiceIndisponibleError('Vérification du paiement momentanément impossible', 'FOURNISSEUR_INDISPONIBLE');
  }
  if (!evt.valide) {
    logger.warn('[webhook] IPN PayDunya refusée', { ...contexte, motif: evt.motif });
    throw new UnauthorizedError('Signature invalide', 'SIGNATURE_INVALIDE');
  }
  return evt;
}

async function paydunyaIpn(providerId, corps) {
  const moyen = await moyenIntegre(providerId, 'paydunya');
  const evt = await verifierIpnPaydunya(moyen.credentials, corps, { providerId });
  // Référence absente des données personnalisées : la transaction est
  // retrouvée par le jeton de facture enregistré à l'initiation.
  if (!evt.reference) {
    const tx = await PaymentTransaction.findOne({ where: { owner_id: moyen.owner_id, provider_token: evt.jeton }, attributes: ['reference'] });
    evt.reference = tx?.reference || null;
  }
  return rapprochement.traiterConfirmation(moyen.owner_id, evt, 'paydunya', evt.facture);
}

async function waveEvenement(providerId, corpsBrut, signature) {
  const moyen = await moyenIntegre(providerId, 'wave');
  // Horodatage exigé NUMÉRIQUE : `t=abc` donnerait NaN, que la fenêtre
  // anti-rejeu de l'adaptateur (|maintenant − t| > tolérance) laisserait passer.
  const horodatages = typeof signature === 'string' ? signature.split(',').map((p) => p.trim()).filter((p) => p.startsWith('t=')) : [];
  const horodatageNumerique = horodatages.length === 1 && /^t=\d{1,12}$/.test(horodatages[0]);
  if (!horodatageNumerique || !wave.verifierSignature(moyen.credentials, corpsBrut, signature)) {
    logger.warn('[webhook] Événement Wave à signature invalide refusé', { providerId });
    throw new UnauthorizedError('Signature invalide', 'SIGNATURE_INVALIDE');
  }
  const evenement = JSON.parse(corpsBrut.toString('utf8'));
  return rapprochement.traiterConfirmation(moyen.owner_id, wave.interpreterEvenement(evenement), 'wave', evenement);
}

/**
 * Statuts de livraison WhatsApp (envoyé, distribué, lu, échec) reportés dans
 * `message_deliveries` (§ 54.3). Un statut ne régresse jamais (un « lu » reçu
 * avant « distribué » n'est pas écrasé).
 */
const RANG = { en_attente: 0, envoye: 1, distribue: 2, lu: 3, echec: 3 };

async function whatsappStatuts(corpsBrut, signature) {
  if (!whatsapp.verifierSignature(corpsBrut, signature)) throw new UnauthorizedError('Signature invalide', 'SIGNATURE_INVALIDE');
  const charge = JSON.parse(corpsBrut.toString('utf8'));
  const statuts = (charge.entry || []).flatMap((e) => (e.changes || []).flatMap((c) => c.value?.statuses || []));
  let mis = 0;
  for (const s of statuts) {
    const statut = whatsapp.STATUTS[s.status];
    if (!statut || !s.id) continue;
    const envoi = await MessageDelivery.findOne({ where: { provider_message_id: s.id } });
    if (!envoi || RANG[statut] < RANG[envoi.status]) continue;
    const horodatage = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
    const champs = { status: statut };
    if (statut === 'distribue') champs.delivered_at = horodatage;
    if (statut === 'lu') champs.read_at = horodatage;
    if (statut === 'echec') {
      champs.failed_at = horodatage;
      champs.error = (s.errors || []).map((e) => `${e.code} ${e.title}`).join('; ').slice(0, 500) || 'échec';
    }
    await envoi.update(champs);
    mis += 1;
  }
  return { mis_a_jour: mis };
}

module.exports = { paydunyaIpn, verifierIpnPaydunya, waveEvenement, whatsappStatuts };
