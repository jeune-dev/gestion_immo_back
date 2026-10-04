'use strict';

const crypto = require('crypto');
const { Disjoncteur } = require('../../utils/circuitBreaker.js');
const { comparerTempsConstant } = require('./signature.js');

/**
 * Wave — API Checkout (paiement intégré direct, § 51.2 mode A).
 *
 * Identifiants du PROPRIÉTAIRE (`payment_providers.credentials`) :
 *   { api_key, webhook_secret }
 *
 * Webhook : en-tête `Wave-Signature: t=<horodatage>,v1=<hmac>` où
 * hmac = HMAC-SHA256(webhook_secret, horodatage + corps BRUT). L'horodatage
 * est borné (5 minutes) pour refuser le rejeu d'une notification capturée.
 */

const BASE_URL = () => process.env.WAVE_BASE_URL || 'https://api.wave.com';
const TOLERANCE_S = parseInt(process.env.WAVE_WEBHOOK_TOLERANCE_S || '300', 10);

const disjoncteur = new Disjoncteur('wave', {
  libelle: 'de paiement Wave',
  delaiAppelMs: parseInt(process.env.WAVE_TIMEOUT_MS || '20000', 10),
  estEchecDependance: (err) => !(err.statut && err.statut < 500),
});

/**
 * @returns {Promise<{ jeton: string, urlPaiement: string }>}
 */
async function demanderPaiement({ identifiants, reference, montant, urlSucces, urlAnnulation }) {
  return disjoncteur.executer(async () => {
    const reponse = await fetch(`${BASE_URL()}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${identifiants.api_key}`,
        'Content-Type': 'application/json',
        // Idempotence côté Wave : un nouvel essai réseau ne crée pas une
        // seconde session pour la même transaction.
        'Idempotency-Key': reference,
      },
      body: JSON.stringify({
        amount: String(montant),
        currency: 'XOF',
        client_reference: reference,
        success_url: urlSucces,
        error_url: urlAnnulation,
      }),
    });
    const json = await reponse.json().catch(() => ({}));
    if (!reponse.ok || !json.wave_launch_url) {
      const err = new Error(json.message || json.code || `Wave HTTP ${reponse.status}`);
      err.statut = reponse.ok ? 400 : reponse.status;
      throw err;
    }
    return { jeton: json.id, urlPaiement: json.wave_launch_url };
  });
}

/** Vérifie la signature d'un webhook Wave sur le corps BRUT. */
function verifierSignature(identifiants, corpsBrut, entete, maintenant = Date.now()) {
  if (!identifiants?.webhook_secret || !corpsBrut?.length || typeof entete !== 'string') return false;
  const parties = entete.split(',').map((p) => p.trim().split('='));
  const horodatages = parties.filter(([k]) => k === 't').map(([, v]) => v);
  const signatures = parties.filter(([k]) => k === 'v1').map(([, v]) => v);
  // Un seul horodatage, NUMÉRIQUE : `t=abc` donnerait NaN, que la fenêtre
  // anti-rejeu ci-dessous (NaN > tolérance est faux) ne refuserait jamais.
  if (horodatages.length !== 1 || !/^\d{1,12}$/.test(horodatages[0]) || !signatures.length) return false;
  const t = horodatages[0];
  if (Math.abs(maintenant / 1000 - Number(t)) > TOLERANCE_S) return false;
  const attendu = crypto.createHmac('sha256', identifiants.webhook_secret).update(`${t}${corpsBrut.toString('utf8')}`).digest('hex');
  return signatures.some((s) => comparerTempsConstant(attendu, s));
}

/**
 * Interprète un événement Wave (signature déjà vérifiée).
 * @returns {{ evenement: 'confirme'|'annule'|'ignore', reference?: string, montant?: number, idFournisseur?: string, telephone?: string }}
 */
function interpreterEvenement(evenement) {
  const data = evenement?.data || {};
  const base = {
    reference: data.client_reference || null,
    montant: data.amount !== undefined ? Math.round(Number(data.amount)) : null,
    idFournisseur: data.transaction_id ? `wave:${data.transaction_id}` : (data.id ? `wave:${data.id}` : null),
    telephone: data.sender_mobile || null,
    portefeuille: 'wave',
  };
  if (evenement?.type === 'checkout.session.completed' && data.payment_status === 'succeeded') return { ...base, evenement: 'confirme' };
  if (evenement?.type === 'checkout.session.payment_failed') return { ...base, evenement: 'annule' };
  return { ...base, evenement: 'ignore' };
}

module.exports = { demanderPaiement, verifierSignature, interpreterEvenement, disjoncteur };
