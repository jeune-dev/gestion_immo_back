'use strict';

/**
 * Dates CALENDAIRES (échéances, périodes, dates de paiement).
 *
 * Toutes les dates métier sont des `DATEONLY` au format ISO `AAAA-MM-JJ`. Le
 * marché cible (Sénégal) est en UTC+0 toute l'année, sans heure d'été : la date
 * du jour est calculée dans le fuseau configuré (`APP_TIMEZONE`, défaut
 * Africa/Dakar) pour qu'un serveur hébergé ailleurs ne décale pas les relances.
 *
 * Les calculs se font sur des objets Date en UTC à minuit : aucune dépendance
 * au fuseau du processus.
 */

const FUSEAU = process.env.APP_TIMEZONE || 'Africa/Dakar';

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// en-CA produit exactement AAAA-MM-JJ. Formateur créé une seule fois : sa
// construction (données de fuseau ICU) coûte bien plus que `format`, et la
// date du jour est demandée par presque chaque requête.
const FORMAT_JOUR = new Intl.DateTimeFormat('en-CA', { timeZone: FUSEAU, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Date du jour `AAAA-MM-JJ` dans le fuseau de l'application. */
function aujourdhui(maintenant = new Date()) {
  return FORMAT_JOUR.format(maintenant);
}

/** `AAAA-MM-JJ` → Date UTC à minuit. */
function versDate(iso) {
  const [a, m, j] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, j));
}

/** Date → `AAAA-MM-JJ` (composantes UTC). */
function versIso(date) {
  return date.toISOString().slice(0, 10);
}

/** Nombre de jours dans un mois (mois 0-11). */
function joursDansMois(annee, mois) {
  return new Date(Date.UTC(annee, mois + 1, 0)).getUTCDate();
}

/**
 * Ajoute des mois à une date ISO en bornant le jour au dernier jour du mois
 * (31 janvier + 1 mois = 28/29 février, jamais 3 mars).
 */
function ajouterMois(iso, nb) {
  const d = versDate(iso);
  const cible = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + nb, 1));
  const jour = Math.min(d.getUTCDate(), joursDansMois(cible.getUTCFullYear(), cible.getUTCMonth()));
  cible.setUTCDate(jour);
  return versIso(cible);
}

function ajouterJours(iso, nb) {
  const d = versDate(iso);
  d.setUTCDate(d.getUTCDate() + nb);
  return versIso(d);
}

/** Écart en jours (b − a). */
function ecartJours(a, b) {
  return Math.round((versDate(b) - versDate(a)) / 86400000);
}

/** Même mois, jour borné au dernier jour du mois. */
function avecJour(iso, jour) {
  const d = versDate(iso);
  const max = joursDansMois(d.getUTCFullYear(), d.getUTCMonth());
  d.setUTCDate(Math.min(jour, max));
  return versIso(d);
}

/** Premier jour du mois de `iso`. */
function debutMois(iso) {
  return `${String(iso).slice(0, 7)}-01`;
}

/** Dernier jour du mois de `iso`. */
function finMois(iso) {
  const d = versDate(iso);
  return versIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** « octobre 2026 » */
function libelleMois(iso) {
  const d = versDate(iso);
  return `${MOIS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** « 23/09/2026 » */
function formatFr(iso) {
  if (!iso) return '';
  const s = iso instanceof Date ? versIso(iso) : String(iso).slice(0, 10);
  const [a, m, j] = s.split('-');
  return `${j}/${m}/${a}`;
}

/** `AAAAMMJJ` — utilisé dans les références (PAY-20260923-001). */
function compacte(iso) {
  return String(iso).slice(0, 10).replace(/-/g, '');
}

module.exports = {
  FUSEAU, aujourdhui, versDate, versIso, ajouterMois, ajouterJours, ecartJours,
  avecJour, debutMois, finMois, libelleMois, formatFr, compacte, joursDansMois,
};
