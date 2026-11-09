'use strict';

const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { ok, created, paginated } = require('../../../utils/response.js');
const S = require('../service/espaceLocataire.service.js');
const P = require('../../paiement/service/paiementLocataire.service.js');
const A = require('../../bail/service/accord.service.js');

exports.accueil = asyncHandler(async (req, res) => ok(res, { homes: await S.accueil(req.tenantIds) }));
exports.logement = asyncHandler(async (req, res) => ok(res, { leases: await S.logements(req.tenantIds) }));
exports.echeances = asyncHandler(async (req, res) => paginated(res, await S.echeances(req.tenantIds, req.query, req.pagination), req.pagination));
exports.echeance = asyncHandler(async (req, res) => ok(res, { schedule: await S.echeance(req.tenantIds, req.params.id) }));
exports.consentement = asyncHandler(async (req, res) => ok(res, { consents: await S.consentementWhatsapp(req.tenantIds, req.body) }, 'Préférence WhatsApp enregistrée'));

// Paiements (§ 12, § 51).
exports.moyens = asyncHandler(async (req, res) => ok(res, { methods: await P.moyensDisponibles(req.tenantIds, req.query.lease_id) }));
exports.paiements = asyncHandler(async (req, res) => paginated(res, await P.paiements(req.tenantIds, req.pagination), req.pagination));
exports.transactions = asyncHandler(async (req, res) => paginated(res, await P.transactions(req.tenantIds, req.pagination), req.pagination));
exports.transaction = asyncHandler(async (req, res) => ok(res, { transaction: await P.transaction(req.tenantIds, req.params.id) }));

exports.initier = asyncHandler(async (req, res) => {
  const { transaction, checkout_url: url, reutilisee } = await P.initier(req.user, req.tenantIds, req.body);
  const data = {
    transaction: {
      id: transaction.id, reference: transaction.reference, amount: transaction.amount, wallet: transaction.wallet,
      status: transaction.status, expires_at: transaction.expires_at,
    },
    checkout_url: url,
    reused: reutilisee,
  };
  return reutilisee ? ok(res, data, 'Demande de paiement en cours réutilisée') : created(res, data, 'Demande de paiement créée : confirmez dans votre application de paiement');
});

exports.preuve = asyncHandler(async (req, res) => {
  const tx = await P.deposerPreuve(req.user, req.tenantIds, req.body, req.fichier || null);
  return created(res, {
    transaction: { id: tx.id, reference: tx.reference, amount: tx.amount, wallet: tx.wallet, status: tx.status },
  }, 'Preuve transmise : en attente de validation par votre bailleur');
});

// Accords : bail proposé, avenant de loyer, congé.
exports.accords = asyncHandler(async (req, res) => ok(res, await A.accords(req.tenantIds)));
exports.accepterBail = asyncHandler(async (req, res) => ok(res, { lease: await A.accepterBail(req.user, req.tenantIds, req.params.id) }, 'Bail accepté'));
exports.refuserBail = asyncHandler(async (req, res) => ok(res, { lease: await A.refuserBail(req.user, req.tenantIds, req.params.id, req.body) }, 'Bail refusé'));
exports.accepterAvenant = asyncHandler(async (req, res) => ok(res, await A.accepterAvenant(req.user, req.tenantIds, req.params.id), 'Nouveau loyer accepté'));
exports.refuserAvenant = asyncHandler(async (req, res) => ok(res, { amendment: await A.refuserAvenant(req.user, req.tenantIds, req.params.id, req.body) }, 'Nouveau loyer refusé'));
exports.conge = asyncHandler(async (req, res) => ok(res, { lease: await A.congeLocataire(req.tenantIds, req.params.id, req.body) }, 'Congé envoyé à votre bailleur'));
exports.annulerConge = asyncHandler(async (req, res) => ok(res, { lease: await A.annulerCongeLocataire(req.tenantIds, req.params.id) }, 'Congé retiré'));

// Espèces déclarées, reçu d'un paiement, contestation d'un remboursement.
const Recu = require('../../paiement/service/recuPaiement.service.js');
const { envoyerPdf } = require('../../paiement/controller/paiement.controller.js');

exports.especes = asyncHandler(async (req, res) => {
  const tx = await P.declarerEspeces(req.user, req.tenantIds, req.body);
  return created(res, {
    transaction: { id: tx.id, reference: tx.reference, amount: tx.amount, wallet: tx.wallet, status: tx.status },
  }, 'Remise d’espèces signalée : en attente de confirmation par votre bailleur');
});
exports.recu = asyncHandler(async (req, res) => envoyerPdf(res, await Recu.recuLocataire(req.params.id, req.tenantIds)));
exports.contesterRemboursement = asyncHandler(async (req, res) => ok(res, { payment: await Recu.contester(req.user, req.tenantIds, req.params.id, req.body) }, 'Contestation envoyée à votre bailleur'));
