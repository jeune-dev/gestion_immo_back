'use strict';

const { Notification, MessageDelivery, OwnerMember, Tenant, WhatsappTemplate } = require('../../../models/index.js');
const push = require('../../../infrastructure/push.service.js');
const whatsapp = require('../../../infrastructure/whatsapp.service.js');
const droits = require('../../abonnement/service/droits.service.js');
const parametres = require('../../parametres/service/parametres.service.js');
const { DEFAUTS_PROPRIETAIRE } = require('../../../config/parametres.js');
const { masquerTelephone } = require('../../../utils/telephone.js');
const logger = require('../../../utils/logger.js');

/**
 * Notifications (§ 27) et relances multicanales (§ 14, § 54).
 *
 * 1. La notification INTERNE est écrite dans la transaction de l'action qui la
 *    déclenche : une action annulée ne notifie personne, une action validée
 *    notifie toujours.
 * 2. Les canaux EXTERNES (push, WhatsApp) partent APRÈS le COMMIT, sans
 *    bloquer la réponse HTTP : une panne de Firebase ou de Meta ne fait jamais
 *    échouer un paiement.
 * 3. Ordre de repli configurable par propriétaire (§ 54.3) : push, puis
 *    WhatsApp, puis SMS (canal prévu, non disponible en V1). Stratégie
 *    `repli` = s'arrêter au premier canal qui aboutit ; `tous` = tous.
 * 4. WhatsApp exige : consentement du locataire, modèle actif, fonctionnalité
 *    et quota du plan, configuration du compte WhatsApp Business (§ 54.3,
 *    § 56.1 « aucun message WhatsApp sans consentement »).
 * 5. Chaque tentative est journalisée dans `message_deliveries`.
 *
 * Un destinataire : `{ userId?, tenantId? }` — un locataire sans compte
 * applicatif (invitation non activée) reste joignable par WhatsApp.
 */

/**
 * @param {import('sequelize').Transaction|null} t
 * @param {object} n
 * @param {Array<{ userId?: string|null, tenantId?: string|null }>} n.destinataires
 * @param {string|null} n.ownerId
 * @param {string} n.type          (TYPE_NOTIFICATION)
 * @param {string} n.titre
 * @param {string} n.corps
 * @param {object} [n.donnees]     données de navigation pour le mobile (ids)
 * @param {{ evenement: string, parametres: string[] }} [n.whatsapp]
 */
async function notifier(t, { destinataires, ownerId, type, titre, corps, donnees = {}, whatsapp: whatsappMessage = null }) {
  const uniques = dedoublonner(destinataires);
  const notifications = [];
  for (const d of uniques) {
    if (!d.userId) { notifications.push(null); continue; }
    notifications.push(await Notification.create({
      user_id: d.userId, owner_id: ownerId, type, title: titre.slice(0, 150), body: corps, data: donnees,
    }, { transaction: t }));
  }

  const envoyer = () => {
    uniques.forEach((d, i) => {
      diffuser(d, notifications[i], { ownerId, type, titre, corps, donnees, whatsappMessage })
        .catch((err) => logger.warn('[notification] Diffusion externe en échec', { type, error: err.message }));
    });
  };

  if (t && typeof t.afterCommit === 'function') t.afterCommit(envoyer);
  else envoyer();
  return notifications.filter(Boolean);
}

function dedoublonner(destinataires) {
  const vus = new Set();
  return (destinataires || []).filter((d) => {
    const cle = `${d.userId || ''}|${d.tenantId || ''}`;
    if (!d.userId && !d.tenantId) return false;
    if (vus.has(cle)) return false;
    vus.add(cle);
    return true;
  });
}

/** Diffusion externe d'une notification à un destinataire, selon l'ordre de repli. */
async function diffuser(destinataire, notification, { ownerId, type, titre, corps, donnees, whatsappMessage }) {
  const reglages = ownerId ? await parametres.proprietaire(ownerId) : DEFAUTS_PROPRIETAIRE;
  const ordre = reglages.channel_order || DEFAUTS_PROPRIETAIRE.channel_order;
  const tous = reglages.notification_strategy === 'tous';

  for (const canal of ordre) {
    let abouti = false;
    if (canal === 'push' && destinataire.userId) {
      abouti = await envoyerPush(destinataire, notification, { ownerId, type, titre, corps, donnees });
    } else if (canal === 'whatsapp' && destinataire.tenantId && whatsappMessage) {
      abouti = await envoyerWhatsapp(destinataire, notification, { ownerId, whatsappMessage });
    }
    // 'sms' : canal prévu par le cahier des charges « lorsqu'il sera disponible »
    // (§ 54.3, § 47 V2) — aucun fournisseur en V1, il est simplement sauté.
    if (abouti && !tous) return;
  }
}

async function journal(champs) {
  try {
    return await MessageDelivery.create(champs);
  } catch (err) {
    logger.warn('[notification] Journalisation de l’envoi impossible', { error: err.message });
    return null;
  }
}

async function envoyerPush(destinataire, notification, { ownerId, type, titre, corps, donnees }) {
  try {
    const r = await push.envoyerAUtilisateur(destinataire.userId, {
      titre, corps, donnees: { ...donnees, type, notification_id: notification?.id },
    });
    if (r.raison === 'non_configure' || r.raison === 'aucun_appareil') return false;
    await journal({
      owner_id: ownerId, notification_id: notification?.id || null, user_id: destinataire.userId,
      tenant_id: destinataire.tenantId || null, channel: 'push', event_code: type,
      status: r.envoye ? 'envoye' : 'echec', sent_at: r.envoye ? new Date() : null,
      failed_at: r.envoye ? null : new Date(), error: r.envoye ? null : 'Aucun appareil n’a accepté la notification',
    });
    return r.envoye;
  } catch (err) {
    await journal({
      owner_id: ownerId, notification_id: notification?.id || null, user_id: destinataire.userId,
      tenant_id: destinataire.tenantId || null, channel: 'push', event_code: type,
      status: 'echec', failed_at: new Date(), error: err.message.slice(0, 500),
    });
    return false;
  }
}

async function envoyerWhatsapp(destinataire, notification, { ownerId, whatsappMessage }) {
  const base = {
    owner_id: ownerId, notification_id: notification?.id || null, user_id: destinataire.userId || null,
    tenant_id: destinataire.tenantId, channel: 'whatsapp', event_code: whatsappMessage.evenement,
  };
  const ignorer = (motif) => journal({ ...base, status: 'ignore', error: motif }).then(() => false);

  const tenant = await Tenant.findByPk(destinataire.tenantId, { attributes: ['id', 'phone', 'whatsapp_consent'] });
  if (!tenant) return false;
  // § 56.1 — aucun message WhatsApp sans consentement.
  if (!tenant.whatsapp_consent) return ignorer('consentement_absent');
  const modele = await WhatsappTemplate.findOne({ where: { event_code: whatsappMessage.evenement, is_active: true } });
  if (!modele) return ignorer('modele_inactif');
  if (!whatsapp.estConfigure()) return ignorer('whatsapp_non_configure');
  if (!(await droits.quotaWhatsappDisponible(ownerId))) return ignorer('quota_ou_formule');

  try {
    const { id } = await whatsapp.envoyerModele({
      telephone: tenant.phone,
      modele: modele.meta_template_name,
      langue: modele.language_code,
      parametres: whatsappMessage.parametres || [],
    });
    await journal({
      ...base, template_name: modele.meta_template_name, destination: masquerTelephone(tenant.phone),
      status: 'envoye', provider_message_id: id || null, sent_at: new Date(),
    });
    return true;
  } catch (err) {
    await journal({
      ...base, template_name: modele.meta_template_name, destination: masquerTelephone(tenant.phone),
      status: 'echec', failed_at: new Date(), error: err.message.slice(0, 500),
    });
    return false;
  }
}

/** Comptes à notifier pour un espace propriétaire (tous ses membres actifs). */
async function destinatairesProprietaire(ownerId, transaction) {
  const membres = await OwnerMember.findAll({ where: { owner_id: ownerId, status: 'actif' }, attributes: ['user_id'], transaction });
  return membres.map((m) => ({ userId: m.user_id }));
}

/** Destinataire « locataire » à partir d'une fiche (compte applicatif facultatif). */
function destinataireLocataire(tenant) {
  return { userId: tenant.user_id || null, tenantId: tenant.id };
}

module.exports = { notifier, destinatairesProprietaire, destinataireLocataire, diffuser };
