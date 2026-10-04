'use strict';

const { Joi, uuid, dateIso, pagination, tri } = require('../../../validations/common.js');
const { versDate, versIso, ajouterMois } = require('../../../utils/dates.js');

/** Durée maximale d'un rapport : 3 ans (borne de coût des agrégats, § 45). */
const MOIS_MAX = 36;

/**
 * Date qui existe au calendrier (le motif seul accepte « 2026-02-31 », que
 * PostgreSQL refuse ensuite par une erreur 500). Réutilisée par les modules
 * charge, dépense, caisse, travaux et incident.
 */
const dateReelle = dateIso.custom((valeur, aide) => (
  versIso(versDate(valeur)) === valeur ? valeur : aide.message('{{#label}} n’est pas une date du calendrier')
));

/** Période [du, au] obligatoire, ordonnée, d'au plus trois ans. */
function periodeValide(valeur, aide) {
  if (!valeur.du || !valeur.au) return valeur; // absence déjà signalée par `required`
  if (valeur.au < valeur.du) return aide.message('"au" doit être postérieur ou égal à "du"');
  if (valeur.au >= ajouterMois(valeur.du, MOIS_MAX)) return aide.message('La période d’un rapport ne peut pas dépasser 3 ans');
  return valeur;
}

const champs = {
  du: dateReelle.required(),
  au: dateReelle.required(),
  building_id: uuid,
  // § 26 : chaque rapport s'exporte en CSV (tableur) en plus du JSON.
  format: Joi.string().valid('json', 'csv').default('json'),
};

const rapportSchema = Joi.object(champs).custom(periodeValide);

const rentabiliteSchema = Joi.object({
  ...champs,
  ...pagination,
  tri: tri(['resultat_net', 'revenus', 'depenses', 'jours_occupation', 'number']),
}).custom(periodeValide);

module.exports = { rapportSchema, rentabiliteSchema, MOIS_MAX, dateReelle };
