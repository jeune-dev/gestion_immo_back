'use strict';

const { Op } = require('sequelize');
const {
  Receipt, RentSchedule, Lease, Tenant, Apartment, Building, Owner, Document,
} = require('../../../models/index.js');
const { prochainNumero, pad } = require('../../../utils/compteur.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { formatFr, aujourdhui } = require('../../../utils/dates.js');
const { chargerPourProprietaire, chargerPourLocataire } = require('../../../utils/acces.js');
const { periode, ordre } = require('../../../utils/liste.js');
const { NotFoundError, ServiceIndisponibleError } = require('../../../errors/AppError.js');
const pdf = require('../../../infrastructure/pdf.service.js');
const storage = require('../../../infrastructure/storage.service.js');
const documents = require('../../document/service/document.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const logger = require('../../../utils/logger.js');

/**
 * Quittances (§ 13) : générées AUTOMATIQUEMENT quand une échéance devient
 * PAYÉE (§ 44 : « Loyer PAYÉ → Quittance → Notification »), jamais avant.
 *
 * Contenu (§ 13) : immeuble et appartement, locataire, loyer, date, statut
 * PAYÉ, référence(s) de paiement — plus la période et le bailleur.
 * Consultable, téléchargeable et partageable (PDF) par le propriétaire et le
 * locataire. Un remboursement annule la quittance (l'échéance est rouverte,
 * § 51.4) ; un nouveau paiement complet en produit une nouvelle.
 */

async function pdfQuittance({ numero, owner, tenant, apartment, building, echeance, references, date }) {
  return pdf.generer((doc, a) => {
    a.titre('QUITTANCE DE LOYER');
    a.note(`N° ${numero}`);
    doc.moveDown();
    a.champs([
      ['Bailleur', owner.company_name || owner.display_name],
      ['Bien', `${building.name} — Appartement ${apartment.number}`],
      ['Adresse', [building.address, building.city].filter(Boolean).join(', ')],
      ['Locataire', `${tenant.first_name} ${tenant.last_name}`],
      ['Période', `du ${formatFr(echeance.period_start)} au ${formatFr(echeance.period_end)} (${echeance.label})`],
      ['Loyer', formatFcfa(echeance.rent_amount)],
      ['Provision sur charges', echeance.charges_amount ? formatFcfa(echeance.charges_amount) : null],
      ['Total réglé', formatFcfa(echeance.amount_due)],
      ['Date', formatFr(date)],
      ['Statut', 'PAYÉ'],
      ['Référence(s)', references.join(', ')],
    ]);
    doc.moveDown();
    a.paragraphe(
      `Le bailleur reconnaît avoir reçu de ${tenant.first_name} ${tenant.last_name} la somme de ${formatFcfa(echeance.amount_due)} `
      + `au titre du loyer et des charges de la période indiquée, et lui en donne quittance, sous réserve de tous droits.`
    );
    a.note('Document généré automatiquement après confirmation du paiement par le serveur.');
  }, { titre: `Quittance ${numero}` });
}

/**
 * Crée la quittance d'une échéance payée.
 *
 * Constat M10 de l'audit : le PDF était produit et envoyé au stockage objet
 * PENDANT la transaction du paiement, qui tient le verrou du compteur de
 * quittances du propriétaire — un stockage lent bloquait tous ses paiements
 * et pouvait épuiser le pool de connexions. Désormais :
 *   - DANS la transaction : numéro (compteur) et ligne de quittance seulement ;
 *   - APRÈS validation (afterCommit, aucun verrou tenu) : PDF, stockage,
 *     rattachement du document — toute erreur est journalisée et rattrapée
 *     par la tâche `quittancesManquantes`, jamais renvoyée au payeur.
 *
 * @param {import('sequelize').Transaction} t
 * @param {object} echeance   ligne rent_schedules (statut « paye »)
 * @param {string[]} references références des paiements qui l'ont soldée
 */
async function genererPourEcheance(t, echeance, references) {
  const annee = aujourdhui().slice(0, 4);
  const numero = `QUI-${annee}-${pad(await prochainNumero(`owner:${echeance.owner_id}:receipt:${annee}`, t))}`;
  const receipt = await Receipt.create({
    owner_id: echeance.owner_id,
    rent_schedule_id: echeance.id,
    lease_id: echeance.lease_id,
    tenant_id: echeance.tenant_id,
    number: numero,
    amount: echeance.amount_due,
    issued_at: new Date(),
    payment_references: references,
  }, { transaction: t });
  t.afterCommit(() => produireDocument(receipt.id));
  return receipt;
}

/**
 * Produit le PDF d'une quittance et le rattache (hors de toute transaction de
 * paiement). Idempotent : une quittance qui a déjà son document est ignorée.
 * Ne lève JAMAIS : appelée après validation du paiement, une erreur ici ne
 * doit pas transformer un paiement réussi en échec pour le payeur.
 * @returns {Promise<boolean>} document produit
 */
async function produireDocument(receiptId) {
  try {
    const receipt = await Receipt.findByPk(receiptId);
    if (!receipt || receipt.document_id) return false;
    const echeance = await RentSchedule.findByPk(receipt.rent_schedule_id);
    const [owner, tenant, apartment] = await Promise.all([
      Owner.findByPk(receipt.owner_id),
      Tenant.findByPk(receipt.tenant_id, { paranoid: false }),
      Apartment.findByPk(echeance.apartment_id, { paranoid: false, include: [{ model: Building, as: 'building', paranoid: false }] }),
    ]);
    const contenu = await pdfQuittance({
      numero: receipt.number, owner, tenant, apartment, building: apartment.building, echeance,
      references: receipt.payment_references || [], date: aujourdhui(),
    });
    return await transactionAvecFichiers(async (t) => {
      // Verrou de CETTE quittance seulement : un remboursement concurrent qui
      // l'annule est sérialisé — un PDF « PAYÉ » annulé n'est jamais partagé.
      const courant = await Receipt.findByPk(receiptId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!courant || courant.document_id) return false;
      const document = await documents.creerDocument({
        ownerId: courant.owner_id, tenantId: courant.tenant_id, entityType: 'receipt', entityId: courant.id,
        category: 'quittance', fichier: { buffer: contenu, type: 'pdf', mime: 'application/pdf', nomOrigine: `${courant.number}.pdf` },
        visibleToTenant: !courant.cancelled_at, uploadedBy: null,
      }, t);
      await courant.update({ document_id: document.id }, { transaction: t });
      return true;
    });
  } catch (err) {
    logger.error('[quittance] PDF non produit — repris par la tâche quittancesManquantes', { receiptId, error: err.message });
    return false;
  }
}

/** Rattrapage (tâche planifiée) : quittances valides sans document depuis plus de 2 minutes. */
async function produireDocumentsManquants({ limite = 200 } = {}) {
  const manquantes = await Receipt.findAll({
    where: { document_id: null, cancelled_at: null, issued_at: { [Op.lt]: new Date(Date.now() - 2 * 60 * 1000) } },
    attributes: ['id'],
    order: [['issued_at', 'ASC']],
    limit: limite,
  });
  let produites = 0;
  for (const { id } of manquantes) if (await produireDocument(id)) produites += 1;
  return { examinees: manquantes.length, produites };
}

/** Annule la quittance VALIDE d'une échéance (remboursement). */
async function annulerPourEcheance(t, scheduleId, motif) {
  const receipt = await Receipt.findOne({ where: { rent_schedule_id: scheduleId, cancelled_at: null }, transaction: t, lock: t.LOCK.UPDATE });
  if (!receipt) return null;
  await receipt.update({ cancelled_at: new Date(), cancel_reason: motif }, { transaction: t });
  // Le PDF porte « PAYÉ » : il n'est plus partagé avec le locataire (un
  // document annulé ne doit pas pouvoir être présenté comme preuve de
  // paiement). Il est CONSERVÉ pour le propriétaire et l'audit (§ 42).
  if (receipt.document_id) {
    await Document.update({ visible_to_tenant: false }, { where: { id: receipt.document_id }, transaction: t });
  }
  await journaliser({ action: 'quittance.changement_statut', entityType: 'receipt', entityId: receipt.id, ownerId: receipt.owner_id, details: { apres: 'annulee', motif } }, t);
  return receipt;
}

const INCLUDE = [
  { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name'], paranoid: false },
  {
    model: RentSchedule, as: 'schedule', attributes: ['id', 'label', 'period_start', 'period_end', 'due_date', 'amount_due'],
    include: [{ model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false, include: [{ model: Building, as: 'building', attributes: ['id', 'name'], paranoid: false }] }],
  },
];

function filtres(f) {
  const where = {};
  for (const cle of ['lease_id', 'tenant_id']) if (f[cle]) where[cle] = f[cle];
  if (!f.inclure_annulees) where.cancelled_at = null;
  const p = periode(f.du && `${f.du}T00:00:00Z`, f.au && `${f.au}T23:59:59Z`);
  if (p) where.issued_at = p;
  return where;
}

async function lister(ownerId, f, { limit, offset }) {
  return Receipt.findAndCountAll({ where: { ...filtres(f), owner_id: ownerId }, include: INCLUDE, order: ordre(f.tri, '-issued_at'), limit, offset });
}

async function listerPourLocataire(tenantIds, f, { limit, offset }) {
  return Receipt.findAndCountAll({
    where: { ...filtres({ ...f, inclure_annulees: false }), tenant_id: { [Op.in]: tenantIds } },
    include: INCLUDE, order: [['issued_at', 'DESC'], ['id', 'ASC']], limit, offset,
  });
}

async function detail(id, ownerId) {
  return chargerPourProprietaire(Receipt, id, ownerId, { include: INCLUDE }, 'Quittance');
}

async function detailPourLocataire(id, tenantIds) {
  const receipt = await chargerPourLocataire(Receipt, id, tenantIds, { include: INCLUDE }, 'Quittance');
  if (receipt.cancelled_at) throw new NotFoundError('Quittance introuvable');
  return receipt;
}

/** Flux du PDF d'une quittance déjà contrôlée. */
async function ouvrirPdf(receipt) {
  const document = receipt.document_id ? await Document.findByPk(receipt.document_id) : null;
  if (!document) {
    // Quittance créée, PDF en cours de production (ou repris par la tâche) : réessayer.
    throw new ServiceIndisponibleError('Le PDF de la quittance est en cours de génération. Réessayez dans un instant.', 'QUITTANCE_EN_PREPARATION', { reessayerDansS: 5 });
  }
  const objet = await storage.ouvrir(document.storage_key);
  if (!objet) throw new NotFoundError('Fichier de la quittance introuvable');
  return { ...objet, nom: `${receipt.number}.pdf` };
}

module.exports = {
  genererPourEcheance, produireDocument, produireDocumentsManquants, annulerPourEcheance, lister, listerPourLocataire, detail, detailPourLocataire, ouvrirPdf,
};
