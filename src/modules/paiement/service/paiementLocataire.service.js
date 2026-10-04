'use strict';

const crypto = require('crypto');
const { Op, UniqueConstraintError } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  PaymentTransaction, PaymentProvider, RentSchedule, Charge, Lease, RentPayment, Tenant, Owner,
} = require('../../../models/index.js');
const { chargerPourLocataire } = require('../../../utils/acces.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { ConflictError, ValidationError, ServiceIndisponibleError } = require('../../../errors/AppError.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const paydunya = require('../../../infrastructure/paiement/paydunya.provider.js');
const wave = require('../../../infrastructure/paiement/wave.provider.js');
const droits = require('../../abonnement/service/droits.service.js');
const parametres = require('../../parametres/service/parametres.service.js');
const documents = require('../../document/service/document.service.js');
const { notifier, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const logger = require('../../../utils/logger.js');

/**
 * Paiement du loyer par le locataire (§ 12, § 51).
 *
 * Règle fondamentale (§ 12) : le backend ne marque RIEN comme payé à
 * l'initiation. Il crée une demande (référence unique liée à l'échéance, au
 * bail et à l'appartement), renvoie l'adresse de paiement du fournisseur, puis
 * attend la confirmation SIGNÉE (webhook) — ou, en mode preuve, la validation
 * du propriétaire. Quitter ou rouvrir la page de paiement ne change rien.
 *
 * § 44 : double clic et retour dans l'application → une demande encore
 * valide pour la même échéance est RÉUTILISÉE (et l'en-tête Idempotency-Key
 * rejoue la réponse) ; paiement déjà effectué → 409.
 */

/** Référence unique d'une demande de paiement. */
const nouvelleReference = () => `TRX-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

/** Cible (échéance ou charge) du locataire, avec son bail et son reste dû. */
async function chargerCible(tenantIds, { rent_schedule_id: scheduleId, charge_id: chargeId }, t) {
  const Modele = scheduleId ? RentSchedule : Charge;
  const cible = await chargerPourLocataire(Modele, scheduleId || chargeId, tenantIds, { transaction: t, lock: t?.LOCK.UPDATE }, scheduleId ? 'Échéance' : 'Charge');
  const reste = scheduleId ? cible.amount_due - cible.amount_paid : cible.amount - cible.amount_paid;
  if (cible.status === 'annule') throw new ConflictError('Cette échéance est annulée', 'ECHEANCE_ANNULEE');
  if (reste <= 0) throw new ConflictError('Cette échéance est déjà payée', 'DEJA_PAYE');
  const lease = await Lease.findByPk(cible.lease_id, { transaction: t });
  return { cible, lease, reste, estEcheance: Boolean(scheduleId) };
}

/** Moyens de paiement proposés au locataire pour un bail (§ 51.2). */
async function moyensDisponibles(tenantIds, leaseId) {
  const lease = await chargerPourLocataire(Lease, leaseId, tenantIds, {}, 'Bail');
  const [fournisseurs, integreInclus, owner] = await Promise.all([
    PaymentProvider.findAll({ where: { owner_id: lease.owner_id, is_active: true }, attributes: ['id', 'provider', 'mode', 'label', 'account_number'] }),
    droits.aFonctionnalite(lease.owner_id, 'paiement_integre'),
    Owner.findByPk(lease.owner_id, { attributes: ['display_name'] }),
  ]);
  const integres = integreInclus ? fournisseurs.filter((f) => f.mode === 'integre') : [];
  const portefeuillesIntegres = new Set(integres.flatMap((f) => (f.provider === 'paydunya' ? ['wave', 'orange_money'] : [f.provider])));
  return {
    beneficiaire: owner.display_name,
    integre: [...portefeuillesIntegres],
    preuve: fournisseurs.filter((f) => f.mode === 'preuve').map((f) => ({ wallet: f.provider, label: f.label, account_number: f.account_number })),
    especes: true,
  };
}

/** Fournisseur intégré du propriétaire pour un portefeuille (Wave direct prioritaire). */
async function fournisseurIntegre(ownerId, portefeuille, t) {
  const actifs = await PaymentProvider.findAll({ where: { owner_id: ownerId, mode: 'integre', is_active: true }, transaction: t });
  return actifs.find((p) => p.provider === portefeuille) || actifs.find((p) => p.provider === 'paydunya') || null;
}

/**
 * Mode A (§ 51.2) : initie un paiement intégré Wave / Orange Money.
 * @returns {{ transaction, checkout_url, reutilisee: boolean }}
 */
async function initier(user, tenantIds, { rent_schedule_id: scheduleId, charge_id: chargeId, wallet, amount }) {
  const base = (process.env.APP_PUBLIC_URL || '').replace(/\/$/, '');
  const api = (process.env.API_PUBLIC_URL || '').replace(/\/$/, '');
  // Sans adresses publiques, l'URL d'IPN serait RELATIVE : le fournisseur ne
  // pourrait jamais confirmer le paiement et le loyer resterait « en attente »
  // alors que l'argent est parti. Refus AVANT toute création de demande.
  if (!base || !api) {
    throw new ServiceIndisponibleError(
      "Le paiement en ligne n'est pas disponible pour le moment. Payez par un autre moyen ou réessayez plus tard.",
      'PAIEMENT_NON_CONFIGURE'
    );
  }

  const preparation = await sequelize.transaction(async (t) => {
    const { cible, lease, reste } = await chargerCible(tenantIds, { rent_schedule_id: scheduleId, charge_id: chargeId }, t);
    await droits.exigerFonctionnalite(lease.owner_id, 'paiement_integre').catch(() => {
      throw new ConflictError("Le paiement en ligne n'est pas proposé par votre bailleur.", 'PAIEMENT_INTEGRE_INDISPONIBLE');
    });
    const fournisseur = await fournisseurIntegre(lease.owner_id, wallet, t);
    if (!fournisseur) throw new ConflictError(`Le paiement ${wallet === 'wave' ? 'Wave' : 'Orange Money'} n'est pas configuré par votre bailleur.`, 'PAIEMENT_INTEGRE_INDISPONIBLE');
    // Production : jamais de facture sur le bac à sable PayDunya (constat M11).
    if (fournisseur.provider === 'paydunya' && fournisseur.credentials?.mode !== 'live' && paydunya.modeTestInterdit()) {
      logger.error('[paiement] Moyen PayDunya en mode test sur la plateforme de production — paiement refusé', { ownerId: lease.owner_id });
      throw new ConflictError("Le paiement en ligne n'est pas disponible pour le moment. Payez par un autre moyen.", 'PAIEMENT_INTEGRE_INDISPONIBLE');
    }

    const montant = amount ?? reste;
    if (montant > reste) {
      throw new ValidationError('Données invalides', [`Le montant ne peut pas dépasser le reste dû (${formatFcfa(reste)})`], 'MONTANT_SUPERIEUR_AU_DU');
    }

    // Demande encore valide pour la même cible et le même montant : réutilisée.
    const existante = await PaymentTransaction.findOne({
      where: {
        tenant_id: cible.tenant_id,
        [scheduleId ? 'rent_schedule_id' : 'charge_id']: cible.id,
        mode: 'integre',
        wallet,
        amount: montant,
        status: { [Op.in]: ['initiee', 'en_attente'] },
        expires_at: { [Op.gt]: new Date() },
        checkout_url: { [Op.ne]: null },
      },
      transaction: t,
    });
    if (existante) return { existante };

    const { expiration_minutes: minutes } = await parametres.plateforme('paiement');
    const tx = await PaymentTransaction.create({
      owner_id: lease.owner_id,
      tenant_id: cible.tenant_id,
      lease_id: lease.id,
      rent_schedule_id: scheduleId || null,
      charge_id: chargeId || null,
      payment_provider_id: fournisseur.id,
      provider: fournisseur.provider,
      wallet,
      mode: 'integre',
      reference: nouvelleReference(),
      amount: montant,
      status: 'initiee',
      expires_at: new Date(Date.now() + minutes * 60 * 1000),
      initiated_by: user.id,
    }, { transaction: t });
    await journaliser({ action: 'paiement.initiation', entityType: 'payment_transaction', entityId: tx.id, ownerId: lease.owner_id, details: { reference: tx.reference, montant, portefeuille: wallet } }, t);
    // Nom affiché sur la page de paiement : le bailleur, bénéficiaire des fonds.
    const owner = await Owner.findByPk(lease.owner_id, { attributes: ['display_name'], transaction: t });
    return { tx, fournisseur, libelle: cible.label, boutique: owner?.display_name };
  });

  if (preparation.existante) {
    return { transaction: preparation.existante, checkout_url: preparation.existante.checkout_url, reutilisee: true };
  }

  // Appel au fournisseur HORS transaction : une attente réseau ne doit jamais
  // retenir une connexion de base ni un verrou.
  const { tx, fournisseur, libelle, boutique } = preparation;
  const retour = `${base}/paiement/retour?reference=${encodeURIComponent(tx.reference)}`;
  try {
    const adaptateur = fournisseur.provider === 'wave' ? wave : paydunya;
    const { jeton, urlPaiement } = await adaptateur.demanderPaiement({
      identifiants: fournisseur.credentials,
      reference: tx.reference,
      montant: tx.amount,
      libelle: `${libelle} — ${tx.reference}`,
      portefeuille: wallet,
      urlIpn: `${api}/api/v1/webhooks/${fournisseur.provider}/${fournisseur.id}`,
      urlSucces: `${retour}&issue=succes`,
      urlAnnulation: `${retour}&issue=annulation`,
      boutique,
    });
    await tx.update({ status: 'en_attente', provider_token: jeton, checkout_url: urlPaiement });
    return { transaction: tx, checkout_url: urlPaiement, reutilisee: false };
  } catch (err) {
    await tx.update({ status: 'echouee', failed_at: new Date(), rejection_reason: String(err.message).slice(0, 500) });
    logger.warn('[paiement] Initiation refusée par le fournisseur', { reference: tx.reference, error: err.message });
    if (err.statusCode === 503 || !err.statut || err.statut >= 500) {
      throw new ServiceIndisponibleError('Le service de paiement ne répond pas. Réessayez dans quelques instants.', 'FOURNISSEUR_INDISPONIBLE');
    }
    throw new ConflictError('Le fournisseur de paiement a refusé la demande.', 'PAIEMENT_REFUSE_FOURNISSEUR');
  }
}

/**
 * Mode B (§ 51.2) : le locataire a payé sur le numéro du propriétaire et
 * déclare l'identifiant de transaction (et/ou dépose la capture). Le paiement
 * reste « en attente de validation » jusqu'au clic du propriétaire.
 */
async function deposerPreuve(user, tenantIds, donnees, fichier) {
  return transactionAvecFichiers(async (t) => {
    const { cible, lease, reste } = await chargerCible(tenantIds, donnees, t);
    const moyen = await PaymentProvider.findOne({ where: { owner_id: lease.owner_id, provider: donnees.wallet, mode: 'preuve', is_active: true }, transaction: t });
    if (!moyen) throw new ConflictError('Ce moyen de paiement direct n’est pas proposé par votre bailleur.', 'MODE_NON_DISPONIBLE');
    if (donnees.amount > reste) {
      // Un excédent réel reste possible (§ 51.3) : il sera traité à la validation.
      logger.info('[paiement] Preuve supérieure au reste dû — l’excédent sera soumis au propriétaire', { tenantId: cible.tenant_id });
    }

    let tx;
    try {
      tx = await PaymentTransaction.create({
        owner_id: lease.owner_id,
        tenant_id: cible.tenant_id,
        lease_id: lease.id,
        rent_schedule_id: donnees.rent_schedule_id || null,
        charge_id: donnees.charge_id || null,
        payment_provider_id: moyen.id,
        provider: donnees.wallet,
        wallet: donnees.wallet,
        mode: 'preuve',
        reference: nouvelleReference(),
        provider_transaction_id: donnees.provider_transaction_id,
        payer_phone: donnees.payer_phone || null,
        amount: donnees.amount,
        status: 'en_attente',
        initiated_by: user.id,
      }, { transaction: t });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        throw new ConflictError('Cet identifiant de transaction a déjà été déclaré.', 'PREUVE_DEJA_SOUMISE');
      }
      throw err;
    }

    if (fichier) {
      const document = await documents.creerDocument({
        ownerId: lease.owner_id, tenantId: cible.tenant_id, entityType: 'payment_transaction', entityId: tx.id,
        category: 'preuve_paiement', fichier, visibleToTenant: true, uploadedBy: user.id,
      }, t);
      await tx.update({ proof_document_id: document.id }, { transaction: t });
    }

    await journaliser({ action: 'paiement.depot_preuve', entityType: 'payment_transaction', entityId: tx.id, ownerId: lease.owner_id, details: { reference: tx.reference, montant: tx.amount, portefeuille: tx.wallet } }, t);
    const tenant = await Tenant.findByPk(cible.tenant_id, { transaction: t });
    await notifier(t, {
      destinataires: await destinatairesProprietaire(lease.owner_id, t),
      ownerId: lease.owner_id,
      type: 'nouveau_paiement',
      titre: 'Preuve de paiement à valider',
      corps: `${tenant.first_name} ${tenant.last_name} déclare un paiement ${tx.wallet === 'wave' ? 'Wave' : 'Orange Money'} de ${formatFcfa(tx.amount)}.`,
      donnees: { payment_transaction_id: tx.id },
    });
    return tx;
  });
}

async function transactions(tenantIds, { limit, offset }) {
  return PaymentTransaction.findAndCountAll({
    where: { tenant_id: { [Op.in]: tenantIds } },
    attributes: ['id', 'reference', 'provider', 'wallet', 'mode', 'amount', 'status', 'rent_schedule_id', 'charge_id', 'checkout_url', 'rejection_reason', 'confirmed_at', 'created_at', 'expires_at'],
    order: [['created_at', 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
}

/** Statut d'une demande — interrogé par le mobile au retour de la page de paiement (§ 44). */
async function transaction(tenantIds, id) {
  return chargerPourLocataire(PaymentTransaction, id, tenantIds, {
    attributes: ['id', 'tenant_id', 'reference', 'provider', 'wallet', 'mode', 'amount', 'status', 'rent_schedule_id', 'charge_id', 'checkout_url', 'rejection_reason', 'confirmed_at', 'created_at', 'expires_at'],
    include: [{ model: RentPayment, as: 'payment', attributes: ['id', 'reference', 'amount', 'paid_on'] }],
  }, 'Transaction');
}

async function paiements(tenantIds, { limit, offset }) {
  return RentPayment.findAndCountAll({
    where: { tenant_id: { [Op.in]: tenantIds } },
    attributes: ['id', 'reference', 'amount', 'method', 'paid_on', 'status', 'refunded_at'],
    order: [['paid_on', 'DESC'], ['created_at', 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
}

/** Expiration des demandes intégrées abandonnées (job). */
async function expirerDemandes(maintenant = new Date()) {
  const [n] = await PaymentTransaction.update(
    { status: 'annulee', cancelled_at: maintenant },
    { where: { mode: 'integre', status: { [Op.in]: ['initiee', 'en_attente'] }, expires_at: { [Op.lt]: maintenant } } }
  );
  return n;
}

module.exports = { moyensDisponibles, initier, deposerPreuve, transactions, transaction, paiements, expirerDemandes };
