'use strict';

const { UniqueConstraintError, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  PaymentTransaction, Lease, ReconciliationEntry, RentSchedule, Charge, Tenant, RentPayment, Owner,
} = require('../../../models/index.js');
const { aujourdhui } = require('../../../utils/dates.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { normaliserTelephone } = require('../../../utils/telephone.js');
const { chargerPourProprietaire, verifierReference } = require('../../../utils/acces.js');
const { ConflictError, ValidationError } = require('../../../errors/AppError.js');
const allocation = require('./allocation.service.js');
const caisse = require('../../caisse/service/caisse.service.js');
const { notifier, destinataireLocataire, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const logger = require('../../../utils/logger.js');

/**
 * Rapprochement automatique des paiements Wave / Orange Money (§ 51.3).
 *
 * À réception d'une confirmation VÉRIFIÉE (signature du fournisseur) :
 *   1. par RÉFÉRENCE — chaque demande de paiement porte une référence unique
 *      liée à l'échéance, au bail et à l'appartement ;
 *   2. à défaut, par MONTANT + NUMÉRO PAYEUR — une seule échéance ouverte du
 *      propriétaire dont le reste dû est exactement ce montant et dont le
 *      locataire a ce numéro ;
 *   3. sinon → file « À rapprocher », résolue à la main par le propriétaire.
 *
 * Idempotence (§ 51.3 « confirmation reçue deux fois ») : verrou de ligne sur
 * la transaction + statut + index UNIQUE (fournisseur, id de transaction) ; un
 * paiement non identifié est protégé par l'index unique de la file.
 */

const STATUTS_FINAUX = new Set(['confirmee', 'a_rapprocher', 'remboursee']);

/**
 * Mode de paiement (MODE_PAIEMENT) d'un encaissement mobile money. PayDunya
 * n'indique pas le portefeuille utilisé par le payeur (ni l'IPN, ni la facture
 * relue) : sans portefeuille connu, « autre » — jamais le code du fournisseur
 * (« paydunya », refusé par la contrainte CHECK de rent_payments.method), ni un
 * portefeuille deviné.
 */
const methodePaiement = (portefeuille, fournisseur) => portefeuille
  || (['wave', 'orange_money'].includes(fournisseur) ? fournisseur : 'autre');

/**
 * Confirme une transaction connue et impute le paiement.
 * @param {import('sequelize').Transaction} t
 * @param {object} tx ligne payment_transactions verrouillée
 * @param {{ idFournisseur?: string, montant: number, telephone?: string, charge?: object, validePar?: string }} confirmation
 */
async function confirmer(t, tx, { idFournisseur = null, montant, telephone = null, charge = null, validePar = null }) {
  if (STATUTS_FINAUX.has(tx.status)) return { deja: true, transaction: tx };
  if (['annulee', 'echouee'].includes(tx.status) && !validePar) {
    // Confirmation tardive d'un paiement expiré côté application : l'argent est
    // bien arrivé, on le traite quand même (jamais d'encaissement perdu).
    logger.warn('[paiement] Confirmation reçue pour une transaction expirée ou annulée — traitement', { reference: tx.reference });
  }

  const lease = await Lease.findByPk(tx.lease_id, { transaction: t });

  // Cible annulée pendant que le paiement était en vol (échéance ou charge
  // annulée, bail terminé) : l'argent est pourtant arrivé. Le paiement est
  // enregistré SANS cible — imputé aux postes ouverts du bail, du plus ancien
  // au plus récent, et ce que rien ne peut absorber part en « excédent » à
  // décider par le propriétaire (§ 51.3). Jamais d'encaissement perdu, jamais
  // d'erreur métier renvoyée à un webhook correctement signé.
  let cible = tx.rent_schedule_id ? { rent_schedule_id: tx.rent_schedule_id } : (tx.charge_id ? { charge_id: tx.charge_id } : null);
  if (cible) {
    const Modele = cible.rent_schedule_id ? RentSchedule : Charge;
    const visee = await Modele.findByPk(cible.rent_schedule_id || cible.charge_id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!visee || visee.status === 'annule' || visee.lease_id !== lease.id) {
      logger.warn('[paiement] Cible du paiement annulée entre l’initiation et la confirmation — imputation sur le bail', { reference: tx.reference });
      cible = null;
    }
  }

  await tx.update({
    status: 'confirmee',
    confirmed_at: new Date(),
    provider_transaction_id: idFournisseur || tx.provider_transaction_id,
    payer_phone: normaliserTelephone(telephone) || tx.payer_phone,
    raw_payload: charge || tx.raw_payload,
    validated_by: validePar,
    validated_at: validePar ? new Date() : null,
  }, { transaction: t });

  const resultat = await allocation.enregistrerPaiement(t, {
    lease,
    montant,
    methode: methodePaiement(tx.wallet, tx.provider),
    datePaiement: aujourdhui(),
    enregistrePar: validePar || tx.initiated_by,
    transactionId: tx.id,
    cible,
    excedent: 'confirmation',
    acteur: validePar ? null : { id: null, role_code: 'fournisseur_paiement' },
  });
  return { deja: false, transaction: tx, ...resultat };
}

/**
 * Place une confirmation VÉRIFIÉE mais non imputable automatiquement dans la
 * file « À rapprocher » (§ 51.3, § 56.1) : le propriétaire la résout à la main.
 * L'identifiant du fournisseur (index unique) garantit qu'une seconde
 * notification du même paiement ne crée pas une seconde entrée.
 */
async function mettreARapprocher(t, ownerId, evt, fournisseur, telephone, contexte = {}) {
  const { motif = null, transaction_id: transactionId = null, lease_id: leaseId = null } = contexte;
  const lease = leaseId ? await Lease.findByPk(leaseId, { attributes: ['id', 'tenant_id'], transaction: t }) : null;
  const entree = await ReconciliationEntry.create({
    owner_id: ownerId,
    type: 'non_identifie',
    status: 'en_attente',
    amount: evt.montant,
    payer_phone: telephone,
    transaction_id: transactionId,
    lease_id: lease?.id || null,
    tenant_id: lease?.tenant_id || null,
    details: {
      id_fournisseur: evt.idFournisseur || null,
      fournisseur,
      portefeuille: evt.portefeuille || null,
      reference_recue: evt.reference || null,
      recu_le: new Date().toISOString(),
      ...(motif ? { motif } : {}),
    },
  }, { transaction: t });
  await journaliser({ action: 'paiement.a_rapprocher', entityType: 'reconciliation_entry', entityId: entree.id, ownerId, acteur: { id: null, role_code: 'fournisseur_paiement' }, details: { montant: evt.montant, fournisseur, motif } }, t);
  await notifier(t, {
    destinataires: await destinatairesProprietaire(ownerId, t),
    ownerId,
    type: 'rapprochement',
    titre: 'Paiement à rapprocher',
    corps: `Un paiement de ${formatFcfa(evt.montant)} n'a pas pu être associé automatiquement à une échéance.`,
    donnees: { reconciliation_entry_id: entree.id },
  });
  return entree;
}

/**
 * Traite une confirmation de fournisseur pour un espace propriétaire
 * (webhook PayDunya — facture relue chez PayDunya — ou Wave, signature vérifiée).
 * @param {string} ownerId
 * @param {{ evenement: 'confirme'|'annule'|'ignore', reference?: string, montant?: number,
 *           idFournisseur?: string, telephone?: string, portefeuille?: string }} evt
 * @param {string} fournisseur 'paydunya' | 'wave'
 * @param {object} charge  corps brut (conservé pour la traçabilité)
 */
async function traiterConfirmation(ownerId, evt, fournisseur, charge) {
  if (evt.evenement === 'ignore') return { traite: false, motif: 'evenement_ignore' };

  try {
    return await sequelize.transaction(async (t) => {
      const tx = evt.reference
        ? await PaymentTransaction.findOne({ where: { reference: evt.reference, owner_id: ownerId }, transaction: t, lock: t.LOCK.UPDATE })
        : null;

      if (evt.evenement === 'annule') {
        if (tx && ['initiee', 'en_attente'].includes(tx.status)) {
          // Marque « annulée PAR LE FOURNISSEUR » (et non simplement expirée par
          // le job) : voir le traitement d'une confirmation tardive ci-dessous.
          await tx.update({ status: 'annulee', cancelled_at: new Date(), raw_payload: { ...charge, annulation_fournisseur: true } }, { transaction: t });
          await journaliser({ action: 'paiement.changement_statut', entityType: 'payment_transaction', entityId: tx.id, ownerId, acteur: { id: null, role_code: 'fournisseur_paiement' }, details: { apres: 'annulee', reference: tx.reference } }, t);
        }
        return { traite: Boolean(tx), statut: tx?.status };
      }

      // Montant signé mais inexploitable (absent, nul, non numérique) : rien à
      // imputer — la notification est tracée et acquittée, jamais rejouée en boucle.
      if (!Number.isSafeInteger(evt.montant) || evt.montant <= 0) {
        logger.error('[paiement] Confirmation signée au montant inexploitable — ignorée', { reference: evt.reference || null, fournisseur });
        return { traite: false, motif: 'montant_invalide' };
      }

      // 1. Par référence.
      // Confirmation qui CONTREDIT une annulation annoncée par le fournisseur
      // lui-même : état incohérent côté fournisseur. Elle n'est pas imputée
      // automatiquement — elle part dans la file « À rapprocher » : l'argent
      // n'est jamais perdu, mais rien n'est marqué PAYÉ sans que le propriétaire
      // ait vérifié son relevé (§ 12, § 51.3). Une demande seulement EXPIRÉE côté
      // application (job, sans annonce du fournisseur) reste traitée comme une
      // confirmation tardive. Une transaction confirmée n'est jamais rétrogradée
      // (voir « annule » ci-dessus).
      // La confirmation doit être celle de CETTE transaction : même fournisseur
      // et, quand il est connu, même jeton de facture (constat M11 de l'audit —
      // une facture créée hors de l'application sur le même compte, avec une
      // référence choisie, ou une notification d'un autre fournisseur, ne doit
      // jamais solder une échéance d'office). L'argent n'est pas perdu : file
      // « À rapprocher », décision du propriétaire.
      if (tx && (tx.provider !== fournisseur || (tx.provider_token && evt.jeton && tx.provider_token !== evt.jeton))) {
        logger.error('[paiement] Confirmation incohérente avec la transaction visée — mise « À rapprocher »', {
          reference: tx.reference, fournisseurTransaction: tx.provider, fournisseurNotification: fournisseur,
        });
        const entree = await mettreARapprocher(t, ownerId, evt, fournisseur, normaliserTelephone(evt.telephone), {
          motif: 'facture_incoherente', transaction_id: tx.id, lease_id: tx.lease_id,
        });
        return { traite: true, a_rapprocher: true, reconciliation_entry_id: entree.id };
      }
      if (tx && tx.status === 'annulee' && tx.raw_payload?.annulation_fournisseur === true) {
        logger.warn('[paiement] Confirmation reçue après une annulation signée du fournisseur — mise « À rapprocher »', { reference: tx.reference });
        await tx.update({ status: 'a_rapprocher' }, { transaction: t });
        const entree = await mettreARapprocher(t, ownerId, evt, fournisseur, normaliserTelephone(evt.telephone), {
          motif: 'confirmation_apres_annulation', transaction_id: tx.id, lease_id: tx.lease_id,
        });
        return { traite: true, a_rapprocher: true, reconciliation_entry_id: entree.id };
      }
      if (tx) {
        const r = await confirmer(t, tx, { idFournisseur: evt.idFournisseur, montant: evt.montant, telephone: evt.telephone, charge });
        return { traite: true, deja: r.deja, transaction_id: tx.id };
      }

      // 2. Par montant + numéro payeur.
      const telephone = normaliserTelephone(evt.telephone);
      if (telephone && evt.montant > 0) {
        const candidates = await sequelize.query(`
          SELECT rs.id, rs.lease_id, rs.tenant_id FROM rent_schedules rs
            JOIN tenants tn ON tn.id = rs.tenant_id
           WHERE rs.owner_id = :ownerId AND tn.phone = :telephone
             AND rs.status IN ('a_payer', 'partiellement_paye', 'en_retard')
             AND rs.amount_due - rs.amount_paid = :montant
           LIMIT 2`,
        { replacements: { ownerId, telephone, montant: evt.montant }, type: QueryTypes.SELECT, transaction: t });
        if (candidates.length === 1) {
          const [c] = candidates;
          const tenant = await Tenant.findByPk(c.tenant_id, { transaction: t });
          // Initiateur : le compte du locataire s'il l'a activé, sinon le titulaire de l'espace.
          const owner = await Owner.findByPk(ownerId, { attributes: ['user_id'], transaction: t });
          const nouvelle = await PaymentTransaction.create({
            owner_id: ownerId, tenant_id: c.tenant_id, lease_id: c.lease_id, rent_schedule_id: c.id,
            provider: fournisseur, wallet: evt.portefeuille || null, mode: 'integre',
            reference: `TRX-AUTO-${Date.now().toString(36).toUpperCase()}-${c.id.slice(0, 6).toUpperCase()}`,
            amount: evt.montant, status: 'en_attente', initiated_by: tenant.user_id || owner.user_id,
          }, { transaction: t });
          await confirmer(t, nouvelle, { idFournisseur: evt.idFournisseur, montant: evt.montant, telephone, charge });
          return { traite: true, rapproche_par: 'montant_telephone', transaction_id: nouvelle.id };
        }
      }

      // 3. Non identifiable → file « À rapprocher ».
      const entree = await mettreARapprocher(t, ownerId, evt, fournisseur, telephone);
      return { traite: true, a_rapprocher: true, reconciliation_entry_id: entree.id };
    });
  } catch (err) {
    // Deuxième notification d'un paiement déjà enregistré (course entre deux
    // webhooks identiques) : l'index unique a joué son rôle d'arbitre.
    if (err instanceof UniqueConstraintError) return { traite: true, deja: true };
    throw err;
  }
}

// ── File « À rapprocher » (propriétaire) ─────────────────────────────────────

async function lister(ownerId, { status = 'en_attente', type }, { limit, offset }) {
  const where = { owner_id: ownerId };
  if (status) where.status = status;
  if (type) where.type = type;
  return ReconciliationEntry.findAndCountAll({
    where,
    include: [
      { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone'], paranoid: false },
      { model: RentPayment, as: 'payment', attributes: ['id', 'reference', 'amount', 'paid_on'] },
    ],
    order: [['created_at', 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
}

/**
 * Résout une entrée :
 *   - non identifié : le propriétaire désigne le bail (et éventuellement
 *     l'échéance) — le paiement est alors enregistré et imputé ;
 *   - excédent : le propriétaire CONFIRME l'imputation sur les échéances
 *     suivantes (§ 51.3 « après confirmation du propriétaire »).
 */
async function resoudre(ownerId, user, id, { lease_id: leaseId, rent_schedule_id: scheduleId, note }) {
  return sequelize.transaction(async (t) => {
    // Même ordre de verrous que le remboursement : paiement d'origine, puis entrée.
    const apercu = await chargerPourProprietaire(ReconciliationEntry, id, ownerId, { transaction: t, attributes: ['id', 'owner_id', 'type', 'rent_payment_id'] }, 'Entrée de rapprochement');
    if (apercu.type === 'excedent' && apercu.rent_payment_id) {
      await RentPayment.findByPk(apercu.rent_payment_id, { transaction: t, lock: t.LOCK.UPDATE });
    }
    const entree = await ReconciliationEntry.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (entree.status !== 'en_attente') throw new ConflictError('Cette entrée est déjà traitée', 'DEJA_TRAITEE');

    let resultat;
    if (entree.type === 'excedent') {
      resultat = await allocation.imputerCredit(t, entree);
    } else {
      if (!leaseId) throw new ValidationError('Données invalides', ['Le bail à créditer est obligatoire']);
      const lease = await verifierReference(Lease, leaseId, ownerId, 'Bail', { transaction: t });
      if (!['actif', 'termine'].includes(lease.status)) throw new ConflictError('Le bail doit être actif ou terminé', 'BAIL_INVALIDE');
      if (scheduleId) {
        const e = await RentSchedule.findByPk(scheduleId, { transaction: t });
        if (!e || e.lease_id !== lease.id) throw new ValidationError('Données invalides', ["L'échéance ne correspond pas à ce bail"]);
      }
      resultat = await allocation.enregistrerPaiement(t, {
        lease,
        montant: entree.amount,
        methode: methodePaiement(entree.details?.portefeuille, entree.details?.fournisseur),
        datePaiement: aujourdhui(),
        enregistrePar: user.id,
        commentaire: `Rapprochement manuel${entree.details?.id_fournisseur ? ` — ${entree.details.id_fournisseur}` : ''}`,
        cible: scheduleId ? { rent_schedule_id: scheduleId } : null,
        excedent: 'fifo',
        // Confirmation mise de côté pour une demande connue (reçue après une
        // annulation) : le paiement reste relié à sa transaction.
        transactionId: entree.transaction_id || null,
      });
      if (entree.transaction_id) {
        await PaymentTransaction.update(
          { status: 'confirmee', confirmed_at: new Date(), validated_by: user.id, validated_at: new Date() },
          { where: { id: entree.transaction_id, status: 'a_rapprocher' }, transaction: t }
        );
      }
      await entree.update({ lease_id: lease.id, tenant_id: lease.tenant_id, rent_payment_id: resultat.paiement.id }, { transaction: t });
    }

    await entree.update({ status: 'resolu', resolved_by: user.id, resolved_at: new Date(), resolution_note: note || null }, { transaction: t });
    await journaliser({ action: 'rapprochement.resolution', entityType: 'reconciliation_entry', entityId: id, ownerId, details: { type: entree.type, montant: entree.amount, lease_id: entree.lease_id } }, t);
    return { entree, quittances: resultat.quittances };
  });
}

/**
 * Rejette une entrée : l'argent est rendu au payeur (excédent ou paiement
 * étranger au patrimoine). Le remboursement effectué est inscrit en caisse.
 */
async function rejeter(ownerId, user, id, { note, refund_method: methode }) {
  return sequelize.transaction(async (t) => {
    // Excédent : le paiement d'origine est verrouillé AVANT l'entrée — même
    // ordre que le remboursement du paiement, qui déduit les excédents déjà
    // rendus (jamais deux sorties de caisse pour le même argent, jamais d'interblocage).
    const apercu = await chargerPourProprietaire(ReconciliationEntry, id, ownerId, { transaction: t, attributes: ['id', 'owner_id', 'type', 'rent_payment_id'] }, 'Entrée de rapprochement');
    if (apercu.type === 'excedent' && apercu.rent_payment_id) {
      const paiement = await RentPayment.findByPk(apercu.rent_payment_id, { transaction: t, lock: t.LOCK.UPDATE });
      if (paiement && paiement.status !== 'valide') throw new ConflictError('Le paiement d’origine est déjà remboursé', 'DEJA_REMBOURSE');
    }
    const entree = await ReconciliationEntry.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (entree.status !== 'en_attente') throw new ConflictError('Cette entrée est déjà traitée', 'DEJA_TRAITEE');
    await entree.update({ status: 'rejete', resolved_by: user.id, resolved_at: new Date(), resolution_note: note }, { transaction: t });
    if (entree.type === 'excedent') {
      // L'excédent était entré en caisse avec le paiement : sa restitution en sort.
      const lease = await Lease.findByPk(entree.lease_id, { transaction: t, include: [{ association: 'apartment', attributes: ['id', 'building_id'], paranoid: false }] });
      await caisse.enregistrerMouvement(t, {
        ownerId, buildingId: lease.apartment.building_id, apartmentId: lease.apartment.id, direction: 'sortie',
        category: 'remboursement', amount: entree.amount, method: methode, occurredOn: aujourdhui(),
        label: `Remboursement d'excédent — ${entree.details?.reference_paiement || ''}`.trim(), sourceType: 'manuel', createdBy: user.id,
      });
      if (entree.tenant_id) {
        const tenant = await Tenant.findByPk(entree.tenant_id, { transaction: t, paranoid: false });
        await notifier(t, {
          destinataires: [destinataireLocataire(tenant)], ownerId, type: 'nouveau_paiement',
          titre: 'Excédent remboursé', corps: `L'excédent de ${formatFcfa(entree.amount)} de votre paiement vous est remboursé.`,
          donnees: { reconciliation_entry_id: id },
        });
      }
    }
    await journaliser({ action: 'rapprochement.rejet', entityType: 'reconciliation_entry', entityId: id, ownerId, details: { type: entree.type, montant: entree.amount, note } }, t);
    return entree;
  });
}

module.exports = { confirmer, traiterConfirmation, lister, resoudre, rejeter };
