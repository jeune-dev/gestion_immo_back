'use strict';

const { getMessaging } = require('../config/firebase.js');
const { DeviceToken } = require('../models/index.js');
const logger = require('../utils/logger.js');
const { Disjoncteur } = require('../utils/circuitBreaker.js');

/**
 * Notifications push FCM (§ 38 « FCM / APNs selon la plateforme » — FCM
 * achemine aussi vers APNs pour iOS).
 *
 * Sans compte de service Firebase, le push est ignoré : la notification
 * interne reste enregistrée en base dans tous les cas (§ 27).
 */

const disjoncteur = new Disjoncteur('fcm', { libelle: 'de notification', delaiAppelMs: 10_000 });

// Codes FCM d'un jeton définitivement invalide (application désinstallée…).
const JETONS_MORTS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Envoie une notification à tous les appareils d'un utilisateur.
 * @returns {Promise<{ envoye: boolean, raison?: string, reussis?: number }>}
 */
async function envoyerAUtilisateur(userId, { titre, corps, donnees = {} }) {
  const messaging = getMessaging();
  if (!messaging) return { envoye: false, raison: 'non_configure' };

  const appareils = await DeviceToken.findAll({ where: { user_id: userId }, attributes: ['id', 'token'] });
  if (!appareils.length) return { envoye: false, raison: 'aucun_appareil' };

  // FCM n'accepte que des chaînes dans `data`.
  const data = Object.fromEntries(Object.entries(donnees).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]));

  const reponse = await disjoncteur.executer(() => messaging.sendEachForMulticast({
    tokens: appareils.map((a) => a.token),
    notification: { title: titre, body: corps },
    data,
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  }));

  const morts = [];
  reponse.responses.forEach((r, i) => {
    if (!r.success && JETONS_MORTS.has(r.error?.code)) morts.push(appareils[i].id);
  });
  if (morts.length) {
    await DeviceToken.destroy({ where: { id: morts } }).catch((err) => {
      logger.warn('[push] Purge des jetons invalides impossible', { error: err.message });
    });
  }
  return { envoye: reponse.successCount > 0, reussis: reponse.successCount, raison: reponse.successCount ? undefined : 'echec' };
}

module.exports = { envoyerAUtilisateur, disjoncteur };
