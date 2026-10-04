'use strict';

/**
 * Simulateur de PayDunya (et de Wave Checkout) pour les tests : remplace
 * `global.fetch`, seul point de sortie vers les fournisseurs. Tout le reste —
 * webhooks, relecture de la facture, imputation, quittances — est réel.
 *
 * Il tient un registre de FACTURES comme PayDunya : créées par
 * `checkout-invoice/create`, relues par `checkout-invoice/confirm/:token`.
 * `ipn()` fait évoluer une facture (statut, montant payé) puis construit le
 * corps de l'IPN que PayDunya posterait — le serveur, lui, relit la facture.
 */
const crypto = require('crypto');

/** Clés d'une application PayDunya de TEST (propriétaire). */
const PAYDUNYA = {
  master_key: 'wQzk9ZwR-Qq9m-0hD0-test-cle-principale',
  private_key: 'test_private_rMIdJM3PLLhLjyArx9tF3VURAF5',
  token: 'IivOiOxGJuWhc5znlIiK',
  mode: 'test',
};
/** Clés de l'application PayDunya de la PLATEFORME (abonnements). */
const PAYDUNYA_PLATEFORME = {
  master_key: 'plateforme-cle-principale-paydunya-test',
  private_key: 'test_private_plateforme_0123456789',
  token: 'jeton-plateforme-test',
  mode: 'test',
};

const FACTURES = new Map();
const empreinte = (masterKey) => crypto.createHash('sha512').update(masterKey).digest('hex');
const nouveauJeton = (mode = 'test') => `${mode}_${crypto.randomBytes(5).toString('hex')}`;

/** Pose les variables d'environnement de la plateforme (abonnements). */
function configurerPlateforme(cles = PAYDUNYA_PLATEFORME) {
  process.env.PAYDUNYA_MASTER_KEY = cles.master_key;
  process.env.PAYDUNYA_PRIVATE_KEY = cles.private_key;
  process.env.PAYDUNYA_TOKEN = cles.token;
  process.env.PAYDUNYA_MODE = cles.mode;
}
function retirerPlateforme() {
  for (const v of ['PAYDUNYA_MASTER_KEY', 'PAYDUNYA_PRIVATE_KEY', 'PAYDUNYA_TOKEN', 'PAYDUNYA_MODE']) process.env[v] = '';
}

const reponse = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

/**
 * Remplace global.fetch. Modes : 'ok' | 'refus' (PayDunya/Wave refusent la
 * demande) | 'panne' (tout appel échoue) | 'panne_relecture' (seule la
 * relecture d'une facture échoue : IPN impossible à vérifier).
 * @returns {{ appels: object[], mode: (m: string) => void, restaurer: () => void, facture: (jeton: string) => object }}
 */
function simulerFournisseurs() {
  const origine = global.fetch;
  const etat = { mode: 'ok', appels: [] };
  global.fetch = jest.fn(async (url, options = {}) => {
    const u = String(url);
    let corps = null;
    try { corps = options.body ? JSON.parse(options.body) : null; } catch { corps = options.body; }
    etat.appels.push({ url: u, methode: options.method || 'GET', corps, entetes: options.headers || {} });
    if (etat.mode === 'panne') return reponse(503, { response_code: '9999', response_text: 'Service indisponible' });

    const creation = u.match(/\/(sandbox-api|api)\/v1\/checkout-invoice\/create$/);
    if (creation) {
      if (etat.mode === 'refus') return reponse(200, { response_code: '1001', response_text: 'Invalid Masterkey Specified' });
      const mode = creation[1] === 'api' ? 'live' : 'test';
      const jeton = nouveauJeton(mode);
      FACTURES.set(jeton, {
        token: jeton,
        total_amount: corps.invoice.total_amount,
        description: corps.invoice.description,
        channels: corps.invoice.channels || null,
        custom_data: corps.custom_data || {},
        actions: corps.actions || {},
        store: corps.store,
        master_key: options.headers?.['PAYDUNYA-MASTER-KEY'],
        status: 'pending',
        mode,
        customer: null,
      });
      return reponse(200, {
        response_code: '00',
        response_text: `https://app.paydunya.com/${mode === 'live' ? '' : 'sandbox-'}checkout/invoice/${jeton}`,
        description: 'Checkout Invoice Created',
        token: jeton,
      });
    }

    const relecture = u.match(/\/checkout-invoice\/confirm\/([^/?]+)$/);
    if (relecture) {
      if (etat.mode === 'panne_relecture') return reponse(503, { response_code: '9999', response_text: 'Service indisponible' });
      const f = FACTURES.get(decodeURIComponent(relecture[1]));
      // Les clés présentées doivent être celles qui ont créé la facture.
      if (!f || (f.master_key && f.master_key !== options.headers?.['PAYDUNYA-MASTER-KEY'])) {
        return reponse(200, { response_code: '1004', response_text: 'Invoice Not Found' });
      }
      return reponse(200, {
        response_code: '00',
        response_text: 'Transaction Found',
        hash: empreinte(f.master_key || ''),
        invoice: { token: f.token, total_amount: f.total_amount, description: f.description },
        custom_data: f.custom_data,
        actions: f.actions,
        mode: f.mode,
        status: f.status,
        fail_reason: f.status === 'failed' ? 'Paiement refusé' : '',
        customer: f.customer,
        receipt_url: `https://paydunya.com/sandbox-checkout/receipt/pdf/${f.token}.pdf`,
      });
    }

    if (u.includes('/v1/checkout/sessions')) {
      if (etat.mode === 'refus') return reponse(400, { message: 'refusé' });
      return reponse(200, { id: `cos_${crypto.randomBytes(4).toString('hex')}`, wave_launch_url: 'https://pay.wave.com/c/cos_abc' });
    }
    throw new Error(`Appel réseau inattendu pendant les tests : ${u}`);
  });
  return {
    appels: etat.appels,
    mode: (m) => { etat.mode = m; },
    restaurer: () => { global.fetch = origine; },
    facture: (jeton) => FACTURES.get(jeton),
  };
}

/** Dernière facture créée pour une référence applicative (custom_data.reference). */
function factureDe(reference) {
  let trouvee = null;
  for (const f of FACTURES.values()) if (f.custom_data?.reference === reference) trouvee = f;
  return trouvee;
}

/**
 * Le client paie (ou annule) : la facture de `reference` évolue chez PayDunya,
 * et le corps de l'IPN correspondante est renvoyé (format imbriqué `data`).
 *
 * Sans facture existante pour cette référence (paiement jamais initié par
 * l'application), une facture « étrangère » est créée avec ces clés.
 *
 * @param {string|null} reference  référence applicative (null : aucune)
 * @param {number} montant         montant effectivement réglé chez PayDunya
 * @param {'completed'|'cancelled'|'failed'|'pending'} [statut]
 * @param {object} [o]
 * @param {object} [o.cles]        clés de l'application (empreinte de l'IPN)
 * @param {string} [o.empreinteDe] clé principale utilisée pour l'empreinte (falsification)
 * @param {string} [o.telephone]
 * @param {'test'|'live'} [o.mode]
 */
function ipn(reference, montant, statut = 'completed', { cles = PAYDUNYA, empreinteDe, telephone = '221770000000', mode } = {}) {
  let f = reference ? factureDe(reference) : null;
  if (!f) {
    f = {
      token: nouveauJeton(mode || cles.mode), description: 'Paiement', custom_data: reference ? { reference } : {},
      actions: {}, master_key: cles.master_key, mode: mode || cles.mode, customer: null,
    };
    FACTURES.set(f.token, f);
  }
  Object.assign(f, {
    total_amount: montant,
    status: statut,
    customer: { name: 'Client Test', phone: telephone, email: 'client@exemple.sn' },
    ...(mode ? { mode } : {}),
  });
  return corpsIpn(f, { empreinteDe: empreinteDe ?? cles.master_key });
}

/** Corps d'IPN pour une facture donnée (peut ANNONCER autre chose que la facture réelle). */
function corpsIpn(f, { empreinteDe = PAYDUNYA.master_key, annonce = {} } = {}) {
  return {
    data: {
      response_code: '00',
      response_text: 'Transaction Found',
      hash: empreinte(empreinteDe),
      invoice: { token: f.token, total_amount: String(annonce.total_amount ?? f.total_amount) },
      custom_data: f.custom_data,
      mode: f.mode,
      status: annonce.status ?? f.status,
      customer: f.customer,
    },
  };
}

/** Même IPN au format RÉEL de PayDunya : application/x-www-form-urlencoded. */
function enFormulaire(corps) {
  const paires = [];
  const aplatir = (valeur, prefixe) => {
    if (valeur && typeof valeur === 'object') {
      for (const [k, v] of Object.entries(valeur)) aplatir(v, `${prefixe}[${k}]`);
    } else if (valeur !== undefined && valeur !== null) {
      paires.push(`${encodeURIComponent(prefixe)}=${encodeURIComponent(String(valeur))}`);
    }
  };
  for (const [k, v] of Object.entries(corps)) aplatir(v, k);
  return paires.join('&');
}

module.exports = {
  PAYDUNYA, PAYDUNYA_PLATEFORME, FACTURES, empreinte, simulerFournisseurs, factureDe, ipn, corpsIpn, enFormulaire,
  configurerPlateforme, retirerPlateforme,
};
