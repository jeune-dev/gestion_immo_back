'use strict';

const {
  Joi, uuid, dateIso, montantPositif, telephone, tri, pagination,
} = require('../../../validations/common.js');
const {
  codes, MODE_PAIEMENT, STATUT_PAIEMENT, STATUT_TRANSACTION, MODE_TRANSACTION, FOURNISSEUR_PAIEMENT, PORTEFEUILLE,
  STATUT_RAPPROCHEMENT, TYPE_RAPPROCHEMENT,
} = require('../../../config/enums.js');
const { aujourdhui } = require('../../../utils/dates.js');

const cible = {
  rent_schedule_id: uuid,
  charge_id: uuid,
};

// § 12 — encaissement manuel : montant, date, bail (locataire + appartement), mode, référence, commentaire.
const encaissementSchema = Joi.object({
  lease_id: uuid.required(),
  ...cible,
  amount: montantPositif.required(),
  method: Joi.string().valid('especes', 'virement', 'cheque', 'carte', 'wave', 'orange_money', 'autre').default('especes'),
  // Un encaissement constate un argent DÉJÀ reçu : une date future fausserait
  // la caisse du jour et le reçu (« payé le … »).
  paid_on: dateIso.required().custom((v, aide) => (v <= aujourdhui() ? v : aide.message('{{#label}} ne peut pas être dans le futur'))),
  reference: Joi.string().trim().max(40).pattern(/^[A-Za-z0-9_\-./]+$/).allow(null, ''),
  comment: Joi.string().trim().max(1000).allow(null, ''),
}).oxor('rent_schedule_id', 'charge_id');

const listeSchema = Joi.object({
  ...pagination,
  lease_id: uuid,
  tenant_id: uuid,
  apartment_id: uuid,
  building_id: uuid,
  method: Joi.string().valid(...codes(MODE_PAIEMENT)),
  status: Joi.string().valid(...codes(STATUT_PAIEMENT)),
  du: dateIso,
  au: dateIso,
  tri: tri(['paid_on', 'amount', 'created_at']),
});

const remboursementSchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
  method: Joi.string().valid(...codes(MODE_PAIEMENT)),
});

const transactionsSchema = Joi.object({
  ...pagination,
  status: Joi.string().valid(...codes(STATUT_TRANSACTION)),
  mode: Joi.string().valid(...codes(MODE_TRANSACTION)),
  provider: Joi.string().valid(...codes(FOURNISSEUR_PAIEMENT)),
  tenant_id: uuid,
  lease_id: uuid,
  tri: tri(['created_at', 'amount']),
});

const rejetSchema = Joi.object({ reason: Joi.string().trim().min(3).max(500).required() });

const rapprochementsSchema = Joi.object({
  ...pagination,
  status: Joi.string().valid(...codes(STATUT_RAPPROCHEMENT)),
  type: Joi.string().valid(...codes(TYPE_RAPPROCHEMENT)),
});

const resolutionSchema = Joi.object({
  lease_id: uuid,
  rent_schedule_id: uuid,
  note: Joi.string().trim().max(1000).allow('', null),
});

const rejetRapprochementSchema = Joi.object({
  note: Joi.string().trim().min(3).max(1000).required(),
  refund_method: Joi.string().valid(...codes(MODE_PAIEMENT)).default('especes'),
});

// § 51.5 — identifiants propres au propriétaire.
const moyenSchema = Joi.object({
  provider: Joi.string().valid(...codes(FOURNISSEUR_PAIEMENT)).required(),
  mode: Joi.string().valid(...codes(MODE_TRANSACTION)).required(),
  label: Joi.string().trim().max(100).allow('', null),
  account_number: telephone,
  is_active: Joi.boolean(),
  credentials: Joi.when('provider', {
    is: 'paydunya',
    // Clés de l'application PayDunya Business du propriétaire (« Intégrez notre
    // API » → détails de l'application). La clé publique n'est pas utilisée côté
    // serveur. Des clés de test ne passent jamais en mode « live » (et inversement).
    then: Joi.object({
      master_key: Joi.string().trim().min(8).max(256).required(),
      private_key: Joi.string().trim().min(8).max(256).required(),
      token: Joi.string().trim().min(8).max(256).required(),
      mode: Joi.string().valid('test', 'live').default('test'),
    }).custom((v, aide) => {
      const prefixe = /^(test|live)_/.exec(v.private_key)?.[1];
      return prefixe && prefixe !== v.mode
        ? aide.message(`La clé privée est une clé de ${prefixe === 'test' ? 'TEST' : 'PRODUCTION'} : le mode doit être « ${prefixe} »`)
        : v;
    }),
    otherwise: Joi.object({
      api_key: Joi.string().trim().min(8).max(512).required(),
      webhook_secret: Joi.string().trim().min(8).max(512).required(),
    }),
  }),
});

// ── Locataire ───────────────────────────────────────────────────────────────

const initiationSchema = Joi.object({
  ...cible,
  wallet: Joi.string().valid(...codes(PORTEFEUILLE)).required(),
  amount: montantPositif,
}).xor('rent_schedule_id', 'charge_id');

const preuveSchema = Joi.object({
  ...cible,
  wallet: Joi.string().valid(...codes(PORTEFEUILLE)).required(),
  provider_transaction_id: Joi.string().trim().min(4).max(100).pattern(/^[A-Za-z0-9_\-./]+$/).required(),
  amount: montantPositif.required(),
  payer_phone: telephone,
}).xor('rent_schedule_id', 'charge_id');

const moyensLocataireSchema = Joi.object({ lease_id: uuid.required() });

module.exports = {
  encaissementSchema, listeSchema, remboursementSchema, transactionsSchema, rejetSchema,
  rapprochementsSchema, resolutionSchema, rejetRapprochementSchema, moyenSchema,
  initiationSchema, preuveSchema, moyensLocataireSchema,
};
