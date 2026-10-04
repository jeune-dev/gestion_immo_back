'use strict';

const crypto = require('crypto');
const { Disjoncteur } = require('../../utils/circuitBreaker.js');
const { comparerTempsConstant } = require('./signature.js');

/**
 * PayDunya — agrégateur (Wave, Orange Money, Free Money, carte…), API HTTP/JSON
 * « Paiement Avec Redirection » (developers.paydunya.com/doc/FR/http_json).
 *
 * Les clés sont celles du PROPRIÉTAIRE (`payment_providers.credentials`) : le
 * loyer est encaissé sur SON compte PayDunya Business, la plateforme ne détient
 * pas les fonds (§ 51.5). Pour les abonnements, ce sont celles de la plateforme.
 *
 *   identifiants = { master_key, private_key, token, mode: 'test' | 'live' }
 *
 * AUTHENTICITÉ D'UNE IPN — deux verrous :
 *   1. `data.hash` doit valoir SHA-512(master_key) (contrôle documenté par
 *      PayDunya). Ce hachage est CONSTANT : il prouve que l'émetteur connaît la
 *      clé, mais ne lie ni le statut ni le montant — une IPN capturée pourrait
 *      être rejouée avec un autre contenu.
 *   2. Le contenu de l'IPN n'est donc JAMAIS cru : statut, montant et référence
 *      sont relus auprès de PayDunya (`checkout-invoice/confirm/:token`,
 *      authentifié par nos clés). Seule cette réponse fait foi.
 */

const HOTE = 'https://app.paydunya.com';
const baseUrl = (identifiants) => process.env.PAYDUNYA_BASE_URL
  || `${HOTE}/${identifiants?.mode === 'live' ? 'api' : 'sandbox-api'}/v1`;

const disjoncteur = new Disjoncteur('paydunya', {
  libelle: 'de paiement',
  delaiAppelMs: parseInt(process.env.PAYDUNYA_TIMEOUT_MS || '20000', 10),
  estEchecDependance: (err) => !(err.statut && err.statut < 500),
});

/** Portefeuille choisi dans l'application → canal PayDunya (page de paiement restreinte). */
const CANAUX = { wave: 'wave-senegal', orange_money: 'orange-money-senegal' };

/**
 * En PRODUCTION, aucun paiement de TEST (bac à sable PayDunya) ne doit
 * confirmer un loyer ou un abonnement réel (constat M11 de l'audit) : un
 * moyen resté en mode « test » marquerait des échéances PAYÉES sans argent.
 * Dérogation explicite (préproduction) : PAIEMENT_MODE_TEST_AUTORISE=1.
 * Lu à chaque appel (jamais figé au chargement).
 */
const modeTestInterdit = () => process.env.NODE_ENV === 'production' && process.env.PAIEMENT_MODE_TEST_AUTORISE !== '1';

const entetes = (identifiants) => ({
  'Content-Type': 'application/json',
  'PAYDUNYA-MASTER-KEY': identifiants.master_key,
  'PAYDUNYA-PRIVATE-KEY': identifiants.private_key,
  'PAYDUNYA-TOKEN': identifiants.token,
});

/** Appel JSON : toute réponse sans `response_code = '00'` est une erreur. */
async function appeler(identifiants, chemin, options = {}) {
  return disjoncteur.executer(async () => {
    const reponse = await fetch(`${baseUrl(identifiants)}${chemin}`, { ...options, headers: entetes(identifiants) });
    const json = await reponse.json().catch(() => ({}));
    if (!reponse.ok || String(json.response_code) !== '00') {
      const err = new Error(json.response_text || json.description || `PayDunya HTTP ${reponse.status}`);
      // Refus fonctionnel (clés invalides, montant refusé) : ne compte pas comme
      // une panne du fournisseur pour le disjoncteur.
      err.statut = reponse.ok ? 400 : reponse.status;
      throw err;
    }
    return json;
  });
}

/**
 * Crée une facture PayDunya et renvoie l'URL de la page de paiement.
 * @param {object} p
 * @param {{ master_key: string, private_key: string, token: string, mode?: string }} p.identifiants
 * @param {string} p.reference   référence unique de la transaction (renvoyée dans custom_data)
 * @param {number} p.montant     XOF entier
 * @param {string} p.libelle
 * @param {'wave'|'orange_money'|null} [p.portefeuille]  restreint la page à ce canal
 * @param {string} p.urlIpn
 * @param {string} p.urlSucces
 * @param {string} p.urlAnnulation
 * @param {string} [p.boutique]  nom affiché sur la page de paiement
 * @returns {Promise<{ jeton: string, urlPaiement: string }>}
 */
async function demanderPaiement({ identifiants, reference, montant, libelle, portefeuille, urlIpn, urlSucces, urlAnnulation, boutique }) {
  const corps = {
    invoice: {
      total_amount: montant,
      description: String(libelle).slice(0, 250),
      ...(CANAUX[portefeuille] ? { channels: [CANAUX[portefeuille]] } : {}),
    },
    store: { name: String(boutique || process.env.PAYDUNYA_STORE_NAME || 'Gestion immobilière').slice(0, 100) },
    custom_data: { reference },
    actions: { callback_url: urlIpn, return_url: urlSucces, cancel_url: urlAnnulation },
  };
  const json = await appeler(identifiants, '/checkout-invoice/create', { method: 'POST', body: JSON.stringify(corps) });
  if (!json.token || !json.response_text) {
    const err = new Error('Réponse PayDunya incomplète (jeton ou URL de paiement absent)');
    err.statut = 502;
    throw err;
  }
  return { jeton: String(json.token), urlPaiement: String(json.response_text) };
}

/** Facture telle que PayDunya la connaît (source de vérité du statut et du montant). */
async function consulterFacture(identifiants, jeton) {
  return appeler(identifiants, `/checkout-invoice/confirm/${encodeURIComponent(jeton)}`, { method: 'GET' });
}

const empreinteCle = (masterKey) => crypto.createHash('sha512').update(String(masterKey)).digest('hex');

/**
 * Lit une IPN (POST application/x-www-form-urlencoded, tout sous `data`).
 * Accepte le corps imbriqué (`data.hash`) comme le corps plat produit par un
 * analyseur non étendu (`'data[hash]'`).
 * @returns {{ hash: string|null, jeton: string|null }}
 */
function lireIpn(corps) {
  const c = corps && typeof corps === 'object' ? corps : {};
  const data = c.data && typeof c.data === 'object' ? c.data : null;
  const hash = data?.hash ?? c['data[hash]'] ?? null;
  const jeton = data?.invoice?.token ?? c['data[invoice][token]'] ?? null;
  return {
    hash: typeof hash === 'string' ? hash : null,
    jeton: typeof jeton === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(jeton) ? jeton : null,
  };
}

/** Premier verrou : l'IPN vient d'un émetteur qui connaît la clé principale. */
function verifierEmpreinte(identifiants, hash) {
  if (!identifiants?.master_key || typeof hash !== 'string') return false;
  return comparerTempsConstant(empreinteCle(identifiants.master_key), hash.toLowerCase());
}

/**
 * Interprète la facture RELUE auprès de PayDunya.
 * @returns {{ valide: boolean, evenement?: 'confirme'|'annule'|'ignore', reference?: string|null,
 *             montant?: number, idFournisseur?: string, telephone?: string|null, jeton?: string }}
 */
function interpreterFacture(identifiants, facture) {
  const jeton = facture?.invoice?.token;
  if (!jeton) return { valide: false };
  // Un paiement de TEST ne confirme jamais un loyer réel : ni pour un compte
  // configuré en production, ni sur une plateforme en production.
  if ((identifiants?.mode === 'live' || modeTestInterdit()) && facture.mode !== 'live') return { valide: false };

  const statut = String(facture.status || '').toLowerCase();
  let evenement = 'ignore';
  if (statut === 'completed') evenement = 'confirme';
  else if (statut === 'cancelled' || statut === 'failed') evenement = 'annule';

  const montant = Number(facture.invoice.total_amount);
  return {
    valide: true,
    evenement,
    reference: facture.custom_data?.reference ? String(facture.custom_data.reference) : null,
    montant: Number.isFinite(montant) ? Math.round(montant) : NaN,
    idFournisseur: `paydunya:${jeton}`,
    telephone: facture.customer?.phone || null,
    jeton: String(jeton),
  };
}

/**
 * Chaîne complète d'une IPN : empreinte, relecture chez PayDunya, interprétation.
 * @returns {Promise<{ valide: false, motif: string } | ({ valide: true, facture: object } & ReturnType<typeof interpreterFacture>)>}
 */
async function verifierIpn(identifiants, corps) {
  const { hash, jeton } = lireIpn(corps);
  if (!verifierEmpreinte(identifiants, hash)) return { valide: false, motif: 'signature_invalide' };
  if (!jeton) return { valide: false, motif: 'jeton_absent' };
  const facture = await consulterFacture(identifiants, jeton);
  const evt = interpreterFacture(identifiants, facture);
  // La facture relue doit être celle que l'IPN annonçait.
  if (!evt.valide || evt.jeton !== jeton) return { valide: false, motif: 'facture_incoherente' };
  return { ...evt, facture };
}

module.exports = {
  demanderPaiement, consulterFacture, lireIpn, verifierEmpreinte, interpreterFacture, verifierIpn,
  empreinteCle, CANAUX, disjoncteur, modeTestInterdit,
};
