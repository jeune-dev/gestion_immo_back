'use strict';

const { repartirProportionnellement, formatFcfa } = require('../../../utils/montants.js');
const { ecartJours } = require('../../../utils/dates.js');
const { ValidationError } = require('../../../errors/AppError.js');

/**
 * Calcul PUR de la répartition d'une facture commune (§ 16, § 17) — sans
 * base de données, testé unitairement.
 *
 * Toutes les méthodes se ramènent à une répartition PROPORTIONNELLE à un poids
 * (1 par appartement, consommation, tantième, nombre d'occupants, montant
 * saisi) par `repartirProportionnellement` : la somme des parts est donc
 * TOUJOURS exactement le montant de la facture, l'écart d'arrondi au franc
 * étant attribué de façon déterministe (plus fort reste, puis ordre d'entrée).
 *
 * Chaque ligne porte une explication en français : § 17 « le système conserve
 * la méthode utilisée pour chaque facture afin que le calcul soit explicable ».
 * L'explication ne cite QUE des totaux et la ligne elle-même, jamais un autre
 * appartement : elle est montrée telle quelle au locataire (§ 28).
 */

const DECIMALES_PART = 8;

/** Nombre au format français : « 34,5 », « 1 250,75 » (séparateur de milliers : espace). */
function nombreFr(valeur, decimalesMax = 4) {
  const n = Number(valeur);
  const facteur = 10 ** decimalesMax;
  const arrondi = Math.round(n * facteur) / facteur;
  const [entiere, decimale] = String(Math.abs(arrondi)).split('.');
  const milliers = entiere.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${arrondi < 0 ? '-' : ''}${milliers}${decimale ? `,${decimale}` : ''}`;
}

/** « 8,41 % » — toujours deux décimales, pour que les pourcentages se comparent. */
function pourcentFr(ratio) {
  return `${(Math.round(ratio * 10000) / 100).toFixed(2).replace('.', ',')} %`;
}

/** Part (0..1) arrondie à 8 décimales, comme la colonne `share` numeric(12,8). */
function arrondirPart(ratio) {
  return Math.round(ratio * 10 ** DECIMALES_PART) / 10 ** DECIMALES_PART;
}

/** Unité de consommation par défaut selon le type de charge (compteur). */
function uniteParDefaut(typeCharge) {
  if (typeCharge === 'electricite') return 'kWh';
  if (typeCharge === 'eau') return 'm³';
  return 'unités';
}

const pluriel = (n, singulier, plurielForme = `${singulier}s`) => (Number(n) > 1 ? plurielForme : singulier);

function refuser(message, code = 'REPARTITION_INVALIDE') {
  throw new ValidationError('Répartition impossible', [message], code);
}

/**
 * Vérifie les lignes communes à toutes les méthodes : au moins un
 * appartement, pas de doublon.
 */
function verifierLignes(lignes) {
  if (!Array.isArray(lignes) || lignes.length === 0) refuser('Aucun appartement à répartir.', 'AUCUN_APPARTEMENT');
  const vus = new Set();
  for (const l of lignes) {
    if (vus.has(l.apartment_id)) refuser(`Appartement présent deux fois dans la répartition (${l.numero || l.apartment_id}).`, 'APPARTEMENT_EN_DOUBLE');
    vus.add(l.apartment_id);
  }
}

/** Explication de la répartition égale : « 720 000 FCFA ÷ 12 appartements = 60 000 FCFA ». */
function explicationEgale(total, n, part) {
  const base = `${formatFcfa(total)} ÷ ${n} ${pluriel(n, 'appartement')}`;
  if (part * n === total) return `${base} = ${formatFcfa(part)}`;
  // Division non entière : on montre le quotient exact puis l'arrondi au franc.
  return `${base} = ${nombreFr(total / n, 2)} FCFA, arrondi à ${formatFcfa(part)} (écart d'arrondi réparti au franc près)`;
}

/** Explication d'une part proportionnelle : « 34,5 kWh sur 410 kWh (8,41 %) de 720 000 FCFA = 60 585 FCFA ». */
function explicationProportionnelle({ valeur, somme, total, part, libelleValeur, libelleSomme }) {
  if (valeur === 0) return `${libelleValeur} sur ${libelleSomme} (0,00 %) : aucune part, 0 FCFA`;
  return `${libelleValeur} sur ${libelleSomme} (${pourcentFr(valeur / somme)}) de ${formatFcfa(total)} = ${formatFcfa(part)}`;
}

/**
 * Répartit `total` selon `methode`.
 *
 * @param {'egale'|'consommation'|'coefficient'|'occupants'|'personnalise'} methode
 * @param {number} total  montant entier de la facture (FCFA)
 * @param {Array<{ apartment_id: string, numero?: string, valeur?: number, vacant?: boolean }>} lignes
 *        `valeur` = consommation, coefficient, nombre d'occupants ou montant
 *        selon la méthode (ignorée pour « egale »)
 * @param {{ unite?: string }} [options]
 * @returns {{ methode: string, total: number, base_totale: number|null,
 *   lignes: Array<{ apartment_id: string, numero?: string, basis_value: number|null, share: number, amount: number, explanation: string }> }}
 */
function calculerRepartition(methode, total, lignes, { unite = 'unités' } = {}) {
  if (!Number.isInteger(total) || total <= 0) refuser('Le montant de la facture doit être un entier strictement positif.');
  verifierLignes(lignes);
  const n = lignes.length;

  if (methode === 'egale') {
    const parts = repartirProportionnellement(total, lignes.map(() => 1));
    return {
      methode, total, base_totale: n,
      lignes: lignes.map((l, i) => ({
        apartment_id: l.apartment_id, numero: l.numero,
        basis_value: 1, share: arrondirPart(1 / n), amount: parts[i],
        explanation: explicationEgale(total, n, parts[i]),
      })),
    };
  }

  const valeurs = lignes.map((l) => Number(l.valeur));
  if (valeurs.some((v) => !Number.isFinite(v) || v < 0)) {
    refuser('Chaque appartement doit avoir une valeur positive ou nulle pour cette méthode.', 'VALEUR_MANQUANTE');
  }
  const somme = valeurs.reduce((a, b) => a + b, 0);

  if (methode === 'personnalise') {
    if (valeurs.some((v) => !Number.isInteger(v))) refuser('Les montants personnalisés sont des FCFA entiers.', 'MONTANT_NON_ENTIER');
    if (somme !== total) {
      // Pas d'ajustement silencieux : l'écart est rendu explicite au propriétaire.
      refuser(`La somme des montants saisis (${formatFcfa(somme)}) doit être égale au montant de la facture (${formatFcfa(total)}) ; écart : ${formatFcfa(somme - total)}.`, 'SOMME_DIFFERENTE_DU_TOTAL');
    }
    return {
      methode, total, base_totale: total,
      lignes: lignes.map((l, i) => ({
        apartment_id: l.apartment_id, numero: l.numero,
        basis_value: valeurs[i], share: arrondirPart(valeurs[i] / total), amount: valeurs[i],
        explanation: `Montant personnalisé : ${formatFcfa(valeurs[i])} (${pourcentFr(valeurs[i] / total)} de ${formatFcfa(total)})`,
      })),
    };
  }

  if (!['consommation', 'coefficient', 'occupants'].includes(methode)) refuser(`Méthode de répartition inconnue : ${methode}.`, 'METHODE_INCONNUE');
  if (somme <= 0) {
    const messages = {
      consommation: 'La consommation totale est nulle : impossible de répartir selon la consommation.',
      coefficient: 'La somme des coefficients est nulle : impossible de répartir selon les coefficients.',
      occupants: "Aucun occupant sur la période pour les appartements retenus : impossible de répartir selon le nombre d'occupants.",
    };
    refuser(messages[methode], 'BASE_NULLE');
  }

  const parts = repartirProportionnellement(total, valeurs);
  const libelles = {
    consommation: (v) => `${nombreFr(v)} ${unite}`,
    coefficient: (v) => `Coefficient ${nombreFr(v)}`,
    occupants: (v) => `${nombreFr(v)} ${pluriel(v, 'occupant')}`,
  };
  const libelleSomme = {
    consommation: `${nombreFr(somme)} ${unite}`,
    coefficient: nombreFr(somme),
    occupants: `${nombreFr(somme)} au total`,
  };

  return {
    methode, total, base_totale: somme,
    lignes: lignes.map((l, i) => {
      let explication = explicationProportionnelle({
        valeur: valeurs[i], somme, total, part: parts[i],
        libelleValeur: libelles[methode](valeurs[i]), libelleSomme: libelleSomme[methode],
      });
      if (methode === 'occupants' && valeurs[i] === 0 && l.vacant) {
        explication = 'Aucun bail actif sur la période (logement vacant) : 0 occupant, 0 FCFA';
      }
      return {
        apartment_id: l.apartment_id, numero: l.numero,
        basis_value: valeurs[i], share: arrondirPart(valeurs[i] / somme), amount: parts[i],
        explanation: explication,
      };
    }),
  };
}

/**
 * Statut d'une charge refacturée à une date (fonction pure, réutilisée par le
 * module paiement après chaque imputation) — même logique que les échéances
 * de loyer (§ 11) : payée dès que le montant est couvert, en retard après
 * l'échéance (+ délai de grâce), y compris si elle est partiellement payée.
 *
 * @param {{ amount: number, amount_paid: number, due_date: string, cancelled_at?: any }} c
 * @param {string} jour AAAA-MM-JJ
 * @param {number} [grace=0] délai de grâce en jours (réglage `late_grace_days`)
 * @returns {'a_payer'|'partiellement_paye'|'paye'|'en_retard'|'annule'}
 */
function statutCharge(c, jour, grace = 0) {
  if (c.cancelled_at) return 'annule';
  if (Number(c.amount_paid) >= Number(c.amount)) return 'paye';
  if (ecartJours(c.due_date, jour) > grace) return 'en_retard';
  if (Number(c.amount_paid) > 0) return 'partiellement_paye';
  return 'a_payer';
}

module.exports = {
  calculerRepartition, statutCharge, uniteParDefaut, nombreFr, pourcentFr, arrondirPart,
};
