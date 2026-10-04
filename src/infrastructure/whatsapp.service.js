'use strict';

const crypto = require('crypto');
const { Disjoncteur } = require('../utils/circuitBreaker.js');

/**
 * WhatsApp Business — API officielle (Cloud API de Meta), § 54.
 *
 * Les messages envoyés à l'initiative de l'application utilisent des MODÈLES
 * pré-approuvés (§ 54.3) : seul le type `template` est émis. Les
 * conversations libres sont hors V1.
 *
 * Configuration :
 *   WHATSAPP_PHONE_NUMBER_ID  identifiant du numéro expéditeur
 *   WHATSAPP_ACCESS_TOKEN     jeton d'accès système
 *   WHATSAPP_APP_SECRET       secret de l'application (signature des webhooks)
 *   WHATSAPP_VERIFY_TOKEN     jeton de vérification de l'abonnement webhook
 *   WHATSAPP_API_VERSION      défaut v21.0
 */

const disjoncteur = new Disjoncteur('whatsapp', {
  libelle: 'WhatsApp',
  delaiAppelMs: parseInt(process.env.WHATSAPP_TIMEOUT_MS || '10000', 10),
  estEchecDependance: (err) => !(err.statut && err.statut < 500),
});

function estConfigure() {
  return Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
}

/**
 * Envoie un message modèle.
 * @param {object} p
 * @param {string} p.telephone     E.164 (+221…)
 * @param {string} p.modele        nom du modèle approuvé
 * @param {string} p.langue        code langue du modèle (fr)
 * @param {string[]} p.parametres  valeurs des variables {{1}}, {{2}}…
 * @returns {Promise<{ id: string }>}
 */
async function envoyerModele({ telephone, modele, langue, parametres }) {
  if (!estConfigure()) {
    const err = new Error('WhatsApp non configuré');
    err.statut = 400;
    throw err;
  }
  const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
  const url = `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const corps = {
    messaging_product: 'whatsapp',
    to: String(telephone).replace(/^\+/, ''),
    type: 'template',
    template: {
      name: modele,
      language: { code: langue },
      components: parametres.length
        ? [{ type: 'body', parameters: parametres.map((texte) => ({ type: 'text', text: String(texte).slice(0, 1000) })) }]
        : [],
    },
  };

  return disjoncteur.executer(async () => {
    const reponse = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
    });
    const json = await reponse.json().catch(() => ({}));
    if (!reponse.ok) {
      const err = new Error(json?.error?.message || `WhatsApp HTTP ${reponse.status}`);
      err.statut = reponse.status;
      throw err;
    }
    return { id: json?.messages?.[0]?.id };
  });
}

/**
 * Vérifie la signature `X-Hub-Signature-256` d'un webhook (HMAC-SHA256 du corps
 * BRUT avec le secret de l'application), en temps constant.
 */
function verifierSignature(corpsBrut, entete) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !corpsBrut || typeof entete !== 'string' || !entete.startsWith('sha256=')) return false;
  const attendu = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(corpsBrut).digest('hex')}`);
  const recu = Buffer.from(entete);
  return attendu.length === recu.length && crypto.timingSafeEqual(attendu, recu);
}

/** Statut Meta → statut interne de `message_deliveries`. */
const STATUTS = { sent: 'envoye', delivered: 'distribue', read: 'lu', failed: 'echec' };

module.exports = { estConfigure, envoyerModele, verifierSignature, STATUTS, disjoncteur };
