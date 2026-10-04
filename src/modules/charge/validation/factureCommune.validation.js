'use strict';

const {
  Joi, uuid, montantPositif, montant, tri, recherche, pagination,
} = require('../../../validations/common.js');
const {
  codes, TYPE_CHARGE, METHODE_REPARTITION, STATUT_FACTURE_COMMUNE,
} = require('../../../config/enums.js');
// Date existante au calendrier : « 2026-02-30 » ferait échouer PostgreSQL (500).
const { dateReelle: dateIso } = require('../../rapport/validation/rapport.validation.js');

/**
 * Factures communes (§ 16) et leur répartition (§ 17).
 * `status`, `allocated_at`, `owner_id` ne viennent jamais du client
 * (stripUnknown) : ils ne changent que par les transitions du service.
 */

const champs = {
  building_id: uuid,
  charge_type: Joi.string().valid(...codes(TYPE_CHARGE)),
  supplier: Joi.string().trim().max(120).allow('', null),
  invoice_number: Joi.string().trim().max(60).allow('', null),
  period_start: dateIso,
  period_end: dateIso,
  amount: montantPositif,
  due_date: dateIso.allow(null),
  // § 41 « une facture commune doit avoir une méthode de répartition ».
  allocation_method: Joi.string().valid(...codes(METHODE_REPARTITION)),
  recharge_to_tenants: Joi.boolean(),
  notes: Joi.string().trim().max(5000).allow('', null),
};

const periodeCoherente = (v, aide) => {
  if (v.period_start && v.period_end && v.period_end < v.period_start) {
    return aide.message('La fin de période doit être postérieure ou égale au début de période');
  }
  return v;
};

const creationSchema = Joi.object({
  ...champs,
  building_id: champs.building_id.required(),
  charge_type: champs.charge_type.required(),
  period_start: champs.period_start.required(),
  period_end: champs.period_end.required(),
  amount: champs.amount.required(),
  allocation_method: champs.allocation_method.required(),
}).custom(periodeCoherente);

const modificationSchema = Joi.object(champs).min(1).custom(periodeCoherente);

const listeSchema = Joi.object({
  ...pagination,
  q: recherche,
  building_id: uuid,
  status: Joi.string().valid(...codes(STATUT_FACTURE_COMMUNE)),
  charge_type: Joi.string().valid(...codes(TYPE_CHARGE)),
  // Factures dont la période chevauche [du, au].
  du: dateIso,
  au: dateIso,
  tri: tri(['period_start', 'amount', 'due_date', 'created_at']),
});

/**
 * Paramètres de répartition. La MÉTHODE vient de la facture (§ 17 : elle est
 * fixée à la saisie et conservée) ; ce corps ne fournit que les données
 * propres à la méthode :
 *   - egale        : apartment_ids (facultatif, défaut : tout l'immeuble) ;
 *   - consommation : lines[{ apartment_id, consumption }] (+ unit) ;
 *   - coefficient  : apartment_ids facultatif, lines[{ apartment_id, coefficient }] en surcharge ;
 *   - occupants    : apartment_ids facultatif, lines[{ apartment_id, occupants }] en surcharge ;
 *   - personnalise : lines[{ apartment_id, amount }], somme = montant de la facture.
 */
const ligne = Joi.object({
  apartment_id: uuid.required(),
  consumption: Joi.number().min(0).max(1_000_000_000).precision(4),
  coefficient: Joi.number().min(0).max(1_000_000).precision(4),
  occupants: Joi.number().integer().min(0).max(50),
  amount: montant,
});

const repartitionSchema = Joi.object({
  apartment_ids: Joi.array().items(uuid).min(1).max(1000).unique(),
  lines: Joi.array().items(ligne).min(1).max(1000).unique('apartment_id'),
  unit: Joi.string().trim().max(10),
});

/**
 * Aperçu en GET : les tableaux passent en chaîne de requête — `apartment_ids`
 * en liste séparée par des virgules (ou paramètre répété), `lines` en JSON.
 */
const apercuQuerySchema = Joi.object({
  apartment_ids: Joi.alternatives().try(
    Joi.array().items(uuid).min(1).max(1000).unique(),
    Joi.string().max(40000).custom((v, aide) => {
      const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
      const { error, value } = Joi.array().items(uuid).min(1).max(1000).unique().validate(ids);
      return error ? aide.message('apartment_ids doit être une liste d’identifiants séparés par des virgules') : value;
    })
  ),
  lines: Joi.string().max(100000).custom((v, aide) => {
    let brut;
    try { brut = JSON.parse(v); } catch { return aide.message('lines doit être un tableau JSON'); }
    const { error, value } = Joi.array().items(ligne).min(1).max(1000).unique('apartment_id').validate(brut, { stripUnknown: true });
    return error ? aide.message(`lines invalide : ${error.details[0].message}`) : value;
  }),
  unit: Joi.string().trim().max(10),
});

const annulationSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
});

module.exports = {
  creationSchema, modificationSchema, listeSchema, repartitionSchema, apercuQuerySchema, annulationSchema,
};
