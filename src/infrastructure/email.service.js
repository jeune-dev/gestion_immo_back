'use strict';

const { Resend } = require('resend');
const logger = require('../utils/logger.js');
const { Disjoncteur } = require('../utils/circuitBreaker.js');
const escapeHtml = require('../utils/escapeHtml.js');

/**
 * E-mails transactionnels via Resend (même fournisseur que Widjila et Sign) :
 * code de réinitialisation de mot de passe, invitation locataire.
 *
 * Initialisation paresseuse et tolérante : sans RESEND_API_KEY, l'envoi est
 * ignoré et journalisé — l'application reste utilisable en développement.
 * Le disjoncteur borne le temps d'attente si le fournisseur ne répond plus.
 */

let client = null;
let initialise = false;

function getClient() {
  if (initialise) return client;
  initialise = true;
  if (!process.env.RESEND_API_KEY) {
    logger.warn('[email] RESEND_API_KEY non définie — envoi d’e-mails désactivé');
    return null;
  }
  client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

const disjoncteur = new Disjoncteur('resend', {
  libelle: "d'e-mail",
  delaiAppelMs: parseInt(process.env.EMAIL_TIMEOUT_MS || '10000', 10),
  estEchecDependance: (err) => !(err && err.statusCode && err.statusCode < 500),
});

const EXPEDITEUR = () => process.env.EMAIL_FROM || 'Gestion Immo <no-reply@example.com>';
const NOM_PRODUIT = () => process.env.APP_NAME || 'Gestion Immo';

function gabarit(titre, corpsHtml) {
  return `<!doctype html><html lang="fr"><body style="font-family:Arial,sans-serif;background:#f5f6f8;padding:24px;color:#1f2937">
<div style="max-width:560px;margin:auto;background:#fff;border-radius:8px;padding:24px">
<h2 style="margin-top:0">${escapeHtml(titre)}</h2>${corpsHtml}
<p style="color:#6b7280;font-size:12px;margin-top:32px">${escapeHtml(NOM_PRODUIT())} — message automatique, merci de ne pas y répondre.</p>
</div></body></html>`;
}

/**
 * @returns {Promise<{ envoye: boolean, id?: string, raison?: string }>}
 */
async function envoyer({ a, sujet, html, texte }) {
  const c = getClient();
  if (!c) return { envoye: false, raison: 'non_configure' };
  const reponse = await disjoncteur.executer(() => c.emails.send({ from: EXPEDITEUR(), to: a, subject: sujet, html, text: texte }));
  if (reponse?.error) {
    logger.warn('[email] Envoi refusé par le fournisseur', { error: reponse.error.message });
    return { envoye: false, raison: 'refuse' };
  }
  return { envoye: true, id: reponse?.data?.id };
}

async function envoyerCodeReinitialisation({ email, prenom, code, minutes }) {
  const titre = 'Réinitialisation de votre mot de passe';
  return envoyer({
    a: email,
    sujet: `${NOM_PRODUIT()} — ${titre}`,
    html: gabarit(titre, `<p>Bonjour ${escapeHtml(prenom)},</p>
<p>Votre code de réinitialisation :</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${escapeHtml(code)}</p>
<p>Il expire dans ${minutes} minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.</p>`),
    texte: `Votre code de réinitialisation : ${code} (valable ${minutes} minutes).`,
  });
}

async function envoyerInvitationLocataire({ email, prenom, proprietaire, code, lien, jours }) {
  const titre = 'Activez votre espace locataire';
  return envoyer({
    a: email,
    sujet: `${NOM_PRODUIT()} — ${titre}`,
    html: gabarit(titre, `<p>Bonjour ${escapeHtml(prenom)},</p>
<p>${escapeHtml(proprietaire)} vous invite à suivre votre location (loyers, quittances, demandes) depuis l'application.</p>
<p>Code d'activation : <strong style="font-size:22px;letter-spacing:4px">${escapeHtml(code)}</strong></p>
${lien ? `<p><a href="${escapeHtml(lien)}">Activer mon compte</a></p>` : ''}
<p>Cette invitation expire dans ${jours} jours.</p>`),
    texte: `Code d'activation de votre espace locataire : ${code}${lien ? ` — ${lien}` : ''}`,
  });
}

module.exports = { envoyer, envoyerCodeReinitialisation, envoyerInvitationLocataire, disjoncteur };
