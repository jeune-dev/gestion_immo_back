'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  RentPayment, PaymentAllocation, RentSchedule, Charge, Lease, Tenant, Apartment, Building, Owner, PaymentTransaction,
} = require('../../../models/index.js');
const { MODE_PAIEMENT } = require('../../../config/enums.js');
const { chargerPourProprietaire, chargerPourLocataire } = require('../../../utils/acces.js');
const { formatFr } = require('../../../utils/dates.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { ConflictError } = require('../../../errors/AppError.js');
const pdf = require('../../../infrastructure/pdf.service.js');
const { notifier, destinataireLocataire, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');

/**
 * Reçu de CHAQUE paiement, partiel compris : la quittance n'existe qu'une
 * fois la période soldée, mais le locataire qui remet une partie du loyer
 * doit pouvoir prouver ce qu'il a versé. Le reçu est produit à la demande
 * à partir des écritures (montant, imputations, statut) : il reflète
 * toujours l'état réel du paiement, remboursement compris.
 *
 * Contestation d'un remboursement : le remboursement reste une décision du
 * propriétaire, mais le locataire peut dire qu'il n'a rien reçu ; le
 * propriétaire est alerté et sa réponse est tracée.
 */

const INCLUDE_RECU = [
  { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'user_id'], paranoid: false },
  {
    model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false,
    include: [{ model: Building, as: 'building', attributes: ['id', 'name', 'address', 'city'], paranoid: false }],
  },
  { model: Lease, as: 'lease', attributes: ['id', 'reference', 'owner_id'], include: [{ model: Owner, as: 'owner', attributes: ['id', 'display_name', 'company_name'] }] },
  {
    model: PaymentAllocation, as: 'allocations', attributes: ['id', 'amount', 'reversed_at'],
    include: [
      { model: RentSchedule, as: 'schedule', attributes: ['id', 'label', 'amount_due', 'amount_paid'] },
      { model: Charge, as: 'charge', attributes: ['id', 'label', 'amount', 'amount_paid'] },
    ],
  },
];

async function produire(paiement) {
  const p = paiement;
  const owner = p.lease.owner;
  const actives = p.allocations.filter((a) => !a.reversed_at || p.status === 'rembourse');
  const lignes = actives.map((a) => {
    const poste = a.schedule || a.charge;
    const total = a.schedule ? poste.amount_due : poste.amount;
    const reste = total - poste.amount_paid;
    return [poste.label, formatFcfa(a.amount), p.status === 'rembourse' ? '—' : (reste > 0 ? `reste ${formatFcfa(reste)}` : 'soldé')];
  });
  return pdf.generer((doc, a) => {
    a.titre('REÇU DE PAIEMENT', `N° ${p.reference}`);
    doc.moveDown();
    a.champs([
      ['Bailleur', owner.company_name || owner.display_name],
      ['Bien', `${p.apartment.building.name} — Appartement ${p.apartment.number}`],
      ['Locataire', `${p.tenant.first_name} ${p.tenant.last_name}`],
      ['Bail', p.lease.reference],
      ['Montant reçu', formatFcfa(p.amount)],
      ['Date du paiement', formatFr(p.paid_on)],
      ['Mode', MODE_PAIEMENT[p.method] || p.method],
      ['Statut', p.status === 'rembourse' ? `REMBOURSÉ le ${formatFr(new Date(p.refunded_at).toISOString().slice(0, 10))}` : 'Reçu'],
    ]);
    if (lignes.length) {
      doc.moveDown();
      a.sousTitre('Affectation');
      a.tableau(['Poste', 'Montant affecté', 'Situation'], lignes, [3, 2, 2]);
    }
    doc.moveDown();
    a.paragraphe(
      `Le bailleur reconnaît avoir reçu de ${p.tenant.first_name} ${p.tenant.last_name} la somme de ${formatFcfa(p.amount)} à la date indiquée.`
    );
    a.note('Ce reçu atteste un versement. La quittance de loyer est délivrée lorsque la période est entièrement réglée.');
  }, { titre: `Reçu ${p.reference}` });
}

async function recuProprietaire(id, ownerId) {
  const paiement = await chargerPourProprietaire(RentPayment, id, ownerId, { include: INCLUDE_RECU }, 'Paiement');
  return { buffer: await produire(paiement), nom: `recu-${paiement.reference}.pdf` };
}

async function recuLocataire(id, tenantIds) {
  const paiement = await chargerPourLocataire(RentPayment, id, tenantIds, { include: INCLUDE_RECU }, 'Paiement');
  return { buffer: await produire(paiement), nom: `recu-${paiement.reference}.pdf` };
}

/** Le locataire conteste un remboursement (argent non reçu, montant erroné…). */
async function contester(user, tenantIds, id, { message }) {
  return sequelize.transaction(async (t) => {
    const paiement = await chargerPourLocataire(RentPayment, id, tenantIds, { transaction: t, lock: t.LOCK.UPDATE }, 'Paiement');
    if (paiement.status !== 'rembourse') throw new ConflictError('Seul un paiement remboursé peut être contesté.', 'CONTESTATION_IMPOSSIBLE');
    if (paiement.dispute_status) throw new ConflictError('Ce remboursement a déjà été contesté.', 'DEJA_CONTESTE');
    await paiement.update({ dispute_status: 'conteste', dispute_message: message, disputed_at: new Date() }, { transaction: t });
    await journaliser({ action: 'paiement.contestation_remboursement', entityType: 'rent_payment', entityId: id, ownerId: paiement.owner_id, details: { reference: paiement.reference } }, t);
    const tenant = await Tenant.findByPk(paiement.tenant_id, { attributes: ['first_name', 'last_name'], paranoid: false, transaction: t });
    await notifier(t, {
      destinataires: await destinatairesProprietaire(paiement.owner_id, t), ownerId: paiement.owner_id, type: 'nouveau_paiement',
      titre: 'Remboursement contesté',
      corps: `${tenant.first_name} ${tenant.last_name} conteste le remboursement du paiement ${paiement.reference} (${formatFcfa(paiement.amount)}) : ${message.slice(0, 200)}`,
      donnees: { rent_payment_id: id },
    });
    return paiement;
  });
}

/** Réponse du propriétaire à la contestation : tracée et transmise au locataire. */
async function repondre(ownerId, id, { response }) {
  return sequelize.transaction(async (t) => {
    const paiement = await chargerPourProprietaire(RentPayment, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Paiement');
    if (paiement.dispute_status !== 'conteste') throw new ConflictError("Ce paiement n'a pas de contestation en attente.", 'CONTESTATION_ABSENTE');
    await paiement.update({ dispute_status: 'resolu', dispute_response: response, dispute_resolved_at: new Date() }, { transaction: t });
    await journaliser({ action: 'paiement.reponse_contestation', entityType: 'rent_payment', entityId: id, ownerId, details: { reference: paiement.reference } }, t);
    const tenant = await Tenant.findByPk(paiement.tenant_id, { attributes: ['id', 'user_id'], paranoid: false, transaction: t });
    await notifier(t, {
      destinataires: [destinataireLocataire(tenant)], ownerId, type: 'nouveau_paiement',
      titre: 'Réponse à votre contestation', corps: `Votre bailleur a répondu au sujet du remboursement ${paiement.reference} : ${response.slice(0, 300)}`,
      donnees: { rent_payment_id: id },
    });
    return paiement;
  });
}

/** Délai après lequel une preuve non traitée est rappelée au propriétaire. */
const DELAI_RAPPEL_PREUVE_H = 48;

/** Rappel unique au propriétaire d'une preuve (ou d'espèces déclarées) en attente. */
async function rappelerPreuves(maintenant = new Date()) {
  const avant = new Date(maintenant.getTime() - DELAI_RAPPEL_PREUVE_H * 3_600_000);
  const enAttente = await PaymentTransaction.findAll({
    where: { mode: 'preuve', status: 'en_attente', owner_reminded_at: null, created_at: { [Op.lt]: avant } },
    attributes: ['id', 'owner_id', 'tenant_id', 'amount', 'wallet', 'created_at'],
    limit: 500,
  });
  let n = 0;
  for (const tx of enAttente) {
    await sequelize.transaction(async (t) => {
      const [maj] = await PaymentTransaction.update({ owner_reminded_at: maintenant }, { where: { id: tx.id, status: 'en_attente', owner_reminded_at: null }, transaction: t });
      if (!maj) return;
      const tenant = await Tenant.findByPk(tx.tenant_id, { attributes: ['first_name', 'last_name'], paranoid: false, transaction: t });
      const quoi = tx.wallet === 'especes' ? 'Espèces déclarées' : 'Preuve de paiement';
      await notifier(t, {
        destinataires: await destinatairesProprietaire(tx.owner_id, t), ownerId: tx.owner_id, type: 'nouveau_paiement',
        titre: `${quoi} en attente`,
        corps: `${tenant.first_name} ${tenant.last_name} attend depuis plus de ${DELAI_RAPPEL_PREUVE_H} heures la validation de ${formatFcfa(tx.amount)}. Validez-la ou refusez-la.`,
        donnees: { payment_transaction_id: tx.id },
      });
      n += 1;
    });
  }
  return n;
}

module.exports = { recuProprietaire, recuLocataire, contester, repondre, rappelerPreuves, DELAI_RAPPEL_PREUVE_H };
