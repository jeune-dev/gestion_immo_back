'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Deposit, DepositTransaction, Lease, Tenant, Apartment, Building, Document, Inspection, InspectionItem,
} = require('../../../models/index.js');
const { chargerPourProprietaire, chargerPourLocataire } = require('../../../utils/acces.js');
const { ordre } = require('../../../utils/liste.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { formatFr, aujourdhui, ecartJours } = require('../../../utils/dates.js');
const { ConflictError, ValidationError, ForbiddenError } = require('../../../errors/AppError.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const caisse = require('../../caisse/service/caisse.service.js');
const documents = require('../../document/service/document.service.js');
const pdf = require('../../../infrastructure/pdf.service.js');
const { notifier, destinataireLocataire, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');

/**
 * Cycle de vie de la caution (§ 55) : versement → détention → décompte
 * (retenues justifiées, contestation) → restitution.
 *
 * Règles (§ 55.4) :
 *   - la caution n'est PAS un revenu : ses mouvements de caisse sont marqués
 *     `is_deposit` et exclus de toute rentabilité ;
 *   - toute retenue exige un motif ET un justificatif (contrôle applicatif ET
 *     contrainte SQL) ; le locataire est notifié et peut contester ;
 *   - aucune suppression physique, chaque opération est au journal d'audit.
 *
 * Le STATUT est toujours RECALCULÉ à partir des montants et des contestations
 * (fonction pure `statutCaution`), jamais posé à la main.
 */

/** Montant effectivement retenu par une retenue, selon l'issue de sa contestation. */
function montantRetenu(tr) {
  if (tr.type !== 'retenue') return 0;
  if (tr.contest_status === 'annulee') return 0;
  if (tr.contest_status === 'ajustee') return tr.adjusted_amount ?? 0;
  return tr.amount;
}

/**
 * Statut de la caution (§ 55.2), fonction pure.
 * @param {{ amount_expected, amount_received, amount_withheld, amount_refunded }} d
 * @param {object[]} mouvements  deposit_transactions
 * @param {string} statutBail
 */
function statutCaution(d, mouvements, statutBail) {
  // Litige : une retenue contestée non tranchée, ou maintenue malgré la contestation.
  if (mouvements.some((m) => m.type === 'retenue' && ['conteste', 'maintenue'].includes(m.contest_status))) return 'litige';
  const finDeBail = ['termine', 'clos'].includes(statutBail);
  if (!finDeBail) {
    if (d.amount_received <= 0) return 'attendue';
    return d.amount_received < d.amount_expected ? 'partiellement_versee' : 'detenue';
  }
  if (d.amount_received <= 0) return 'attendue';
  const solde = d.amount_received - d.amount_withheld - d.amount_refunded;
  if (solde > 0) return d.amount_withheld > 0 ? 'retenue_partielle' : 'restitution_en_cours';
  // Solde nul : décompte terminé. Tout retenu sans rien rendre = retenue (intégrale).
  return d.amount_refunded > 0 ? 'restituee' : 'retenue_partielle';
}

/** Recalcule montants et statut depuis les mouvements (verrou posé par l'appelant). */
async function recalculer(t, deposit) {
  const [mouvements, lease] = await Promise.all([
    DepositTransaction.findAll({ where: { deposit_id: deposit.id }, transaction: t }),
    Lease.findByPk(deposit.lease_id, { attributes: ['id', 'status'], transaction: t }),
  ]);
  const somme = (type) => mouvements.filter((m) => m.type === type).reduce((s, m) => s + m.amount, 0);
  const montants = {
    amount_received: somme('versement'),
    amount_withheld: mouvements.reduce((s, m) => s + montantRetenu(m), 0),
    amount_refunded: somme('restitution'),
  };
  const status = statutCaution({ ...deposit.toJSON(), ...montants }, mouvements, lease.status);
  await deposit.update({ ...montants, status, settled_at: ['restituee'].includes(status) ? (deposit.settled_at || new Date()) : null }, { transaction: t });
  return deposit;
}

const solde = (d) => d.amount_received - d.amount_withheld - d.amount_refunded;

const INCLUDE = [
  { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone'], paranoid: false },
  {
    model: Lease, as: 'lease', attributes: ['id', 'reference', 'status', 'start_date', 'end_date', 'ended_on'],
    include: [{ model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false, include: [{ model: Building, as: 'building', attributes: ['id', 'name'], paranoid: false }] }],
  },
];

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['status', 'tenant_id', 'lease_id']) if (f[cle]) where[cle] = f[cle];
  if (f.detenues) where.status = { [Op.notIn]: ['attendue', 'restituee'] };
  return Deposit.findAndCountAll({ where, include: INCLUDE, order: ordre(f.tri, '-created_at'), limit, offset });
}

async function detail(id, ownerId) {
  const deposit = await chargerPourProprietaire(Deposit, id, ownerId, {
    include: [...INCLUDE, { model: DepositTransaction, as: 'transactions', separate: true, order: [['created_at', 'ASC']] }],
  }, 'Caution');
  return { ...deposit.toJSON(), balance: solde(deposit) };
}

async function pdfRecu({ titre, deposit, lease, tenant, mouvement }) {
  return pdf.generer((doc, a) => {
    a.titre(titre);
    doc.moveDown();
    a.champs([
      ['Bail', lease.reference],
      ['Locataire', `${tenant.first_name} ${tenant.last_name}`],
      ['Montant', formatFcfa(mouvement.amount)],
      ['Date', formatFr(mouvement.occurred_on)],
      ['Mode', mouvement.method],
      ['Référence', mouvement.reference],
      ['Caution prévue au bail', formatFcfa(deposit.amount_expected)],
      ['Total versé', formatFcfa(deposit.amount_received)],
      ['Total retenu', deposit.amount_withheld ? formatFcfa(deposit.amount_withheld) : null],
      ['Total restitué', deposit.amount_refunded ? formatFcfa(deposit.amount_refunded) : null],
    ]);
    a.note('La caution ne constitue pas un loyer ; elle est restituée en fin de bail déduction faite des sommes justifiées.');
  }, { titre });
}

/** Opérations communes : verrou, contrôle, mouvement, recalcul, reçu, audit. */
async function operer(ownerId, id, fn) {
  return transactionAvecFichiers(async (t) => {
    const deposit = await chargerPourProprietaire(Deposit, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Caution');
    const lease = await Lease.findByPk(deposit.lease_id, { transaction: t, include: [{ model: Apartment, as: 'apartment', attributes: ['id', 'building_id'], paranoid: false }] });
    const tenant = await Tenant.findByPk(deposit.tenant_id, { transaction: t, paranoid: false });
    return fn({ t, deposit, lease, tenant });
  });
}

/** § 55.3 — versement (espèces, Wave, Orange Money…) avec reçu de caution. */
async function verser(ownerId, user, id, donnees) {
  return operer(ownerId, id, async ({ t, deposit, lease, tenant }) => {
    if (!['actif', 'termine'].includes(lease.status)) throw new ConflictError('Le bail doit être actif pour recevoir la caution.', 'BAIL_INVALIDE');
    if (deposit.amount_received + donnees.amount > deposit.amount_expected) {
      throw new ValidationError('Données invalides', [`Le versement dépasse la caution prévue au bail (reste à verser : ${formatFcfa(deposit.amount_expected - deposit.amount_received)})`], 'CAUTION_DEPASSEE');
    }
    const mouvement = await DepositTransaction.create({
      owner_id: ownerId, deposit_id: deposit.id, type: 'versement', amount: donnees.amount, occurred_on: donnees.occurred_on,
      method: donnees.method, reference: donnees.reference || null, created_by: user.id,
    }, { transaction: t });
    await caisse.enregistrerMouvement(t, {
      ownerId, buildingId: lease.apartment.building_id, apartmentId: lease.apartment.id, direction: 'entree', category: 'caution',
      amount: donnees.amount, method: donnees.method, occurredOn: donnees.occurred_on, label: `Caution — ${lease.reference}`,
      sourceType: 'deposit_transaction', sourceId: mouvement.id, createdBy: user.id,
    });
    await recalculer(t, deposit);
    const contenu = await pdfRecu({ titre: 'REÇU DE CAUTION', deposit, lease, tenant, mouvement });
    const recu = await documents.creerDocument({
      ownerId, tenantId: tenant.id, entityType: 'deposit', entityId: deposit.id, category: 'recu',
      fichier: { buffer: contenu, type: 'pdf', mime: 'application/pdf', nomOrigine: `recu-caution-${lease.reference}.pdf` },
      visibleToTenant: true, uploadedBy: user.id,
    }, t);
    await mouvement.update({ receipt_document_id: recu.id }, { transaction: t });
    await journaliser({ action: 'caution.versement', entityType: 'deposit', entityId: deposit.id, ownerId, details: { montant: donnees.amount, methode: donnees.method, total_verse: deposit.amount_received } }, t);
    await notifier(t, {
      destinataires: [destinataireLocataire(tenant)], ownerId, type: 'caution',
      titre: 'Caution reçue', corps: `Versement de ${formatFcfa(donnees.amount)} reçu pour votre caution (total : ${formatFcfa(deposit.amount_received)}).`,
      donnees: { deposit_id: deposit.id, document_id: recu.id },
      whatsapp: { evenement: 'caution_versement', parametres: [formatFcfa(donnees.amount), formatFcfa(deposit.amount_received)] },
    });
    return { deposit, transaction: mouvement };
  });
}

/** Justificatif d'une retenue (photo, devis, facture) téléversé avant la retenue. */
async function ajouterJustificatif(ownerId, user, id, fichier) {
  return operer(ownerId, id, async ({ t, deposit, tenant }) => {
    const document = await documents.creerDocument({
      ownerId, tenantId: tenant.id, entityType: 'deposit', entityId: deposit.id, category: 'justificatif',
      fichier, visibleToTenant: true, uploadedBy: user.id,
    }, t);
    return documents.versApi(document);
  });
}

/**
 * § 55.3 — retenue (dégradation, loyer impayé, charges) : motif + justificatif
 * obligatoires, pendant le décompte de fin de bail. Le locataire est notifié
 * et peut contester.
 */
async function retenir(ownerId, user, id, donnees) {
  return operer(ownerId, id, async ({ t, deposit, lease, tenant }) => {
    if (!['termine', 'clos'].includes(lease.status)) {
      throw new ConflictError('Une retenue se fait lors du décompte de fin de bail.', 'BAIL_NON_TERMINE');
    }
    if (!donnees.justification_document_ids?.length) {
      throw new ValidationError('Données invalides', ['Une retenue exige au moins un justificatif (§ 55.4)'], 'RETENUE_SANS_JUSTIFICATIF');
    }
    // Les justificatifs doivent appartenir au dossier de CE bail — pièce de
    // la caution elle-même, ou PDF / photo d'un état des lieux de ce bail — ET
    // être visibles du locataire, qui doit pouvoir les examiner pour contester
    // (§ 55.4). Une photo quelconque de l'espace (autre immeuble, brouillon
    // non soumis, document interne) ne justifie rien.
    const inspections = await Inspection.findAll({ where: { lease_id: lease.id }, attributes: ['id'], transaction: t });
    const idsInspections = new Set(inspections.map((i) => i.id));
    const pieces = await Document.findAll({
      where: { id: donnees.justification_document_ids },
      attributes: ['id', 'owner_id', 'tenant_id', 'entity_type', 'entity_id', 'visible_to_tenant'],
      transaction: t,
    });
    const duDossier = (p) => (p.entity_type === 'deposit' && p.entity_id === deposit.id)
      || (p.entity_type === 'inspection' && idsInspections.has(p.entity_id));
    if (pieces.length !== donnees.justification_document_ids.length
      || pieces.some((p) => p.owner_id !== ownerId || p.tenant_id !== tenant.id || !p.visible_to_tenant || !duDossier(p))) {
      throw new ForbiddenError('Justificatif introuvable, non partagé avec le locataire ou étranger au dossier de ce bail.', 'JUSTIFICATIF_INVALIDE');
    }
    // Éléments d'état des lieux invoqués (§ 52.3 étape 6) : ceux des états des lieux de CE bail uniquement.
    const elements = donnees.inspection_item_ids || [];
    if (elements.length) {
      const connus = await InspectionItem.findAll({
        where: { id: elements, inspection_id: [...idsInspections] }, attributes: ['id'], transaction: t,
      });
      if (connus.length !== elements.length) {
        const trouves = new Set(connus.map((c) => c.id));
        throw new ValidationError('Données invalides', elements.filter((e) => !trouves.has(e)).map((e) => `L'élément ${e} n'appartient à aucun état des lieux de ce bail`), 'ELEMENT_ETRANGER');
      }
    }
    if (donnees.amount > solde(deposit)) {
      throw new ValidationError('Données invalides', [`La retenue dépasse la caution disponible (${formatFcfa(solde(deposit))})`], 'RETENUE_SUPERIEURE_AU_SOLDE');
    }
    const mouvement = await DepositTransaction.create({
      owner_id: ownerId, deposit_id: deposit.id, type: 'retenue', amount: donnees.amount, occurred_on: donnees.occurred_on || aujourdhui(),
      reason: donnees.reason, description: donnees.description, justification_document_ids: donnees.justification_document_ids,
      inspection_item_ids: donnees.inspection_item_ids || [], created_by: user.id,
    }, { transaction: t });
    await recalculer(t, deposit);
    await journaliser({ action: 'caution.retenue', entityType: 'deposit', entityId: deposit.id, ownerId, details: { montant: donnees.amount, motif: donnees.reason, justificatifs: donnees.justification_document_ids.length } }, t);
    await notifier(t, {
      destinataires: [destinataireLocataire(tenant)], ownerId, type: 'caution',
      titre: 'Retenue sur votre caution', corps: `Une retenue de ${formatFcfa(donnees.amount)} a été appliquée (${donnees.description}). Vous pouvez la contester depuis votre espace.`,
      donnees: { deposit_id: deposit.id, deposit_transaction_id: mouvement.id },
    });
    return { deposit, transaction: mouvement };
  });
}

/** § 55.3 — restitution du solde (montant, date, mode, accusé du locataire). */
async function restituer(ownerId, user, id, donnees) {
  return operer(ownerId, id, async ({ t, deposit, lease, tenant }) => {
    if (!['termine', 'clos'].includes(lease.status)) throw new ConflictError('La caution se restitue à la fin du bail.', 'BAIL_NON_TERMINE');
    if (donnees.amount > solde(deposit)) {
      throw new ValidationError('Données invalides', [`Montant supérieur au solde de caution (${formatFcfa(solde(deposit))})`], 'RESTITUTION_SUPERIEURE_AU_SOLDE');
    }
    const mouvement = await DepositTransaction.create({
      owner_id: ownerId, deposit_id: deposit.id, type: 'restitution', amount: donnees.amount, occurred_on: donnees.occurred_on,
      method: donnees.method, reference: donnees.reference || null, created_by: user.id,
    }, { transaction: t });
    await caisse.enregistrerMouvement(t, {
      ownerId, buildingId: lease.apartment.building_id, apartmentId: lease.apartment.id, direction: 'sortie', category: 'caution',
      amount: donnees.amount, method: donnees.method, occurredOn: donnees.occurred_on, label: `Restitution de caution — ${lease.reference}`,
      sourceType: 'deposit_transaction', sourceId: mouvement.id, createdBy: user.id,
    });
    await recalculer(t, deposit);
    const contenu = await pdfRecu({ titre: 'RESTITUTION DE CAUTION', deposit, lease, tenant, mouvement });
    const recu = await documents.creerDocument({
      ownerId, tenantId: tenant.id, entityType: 'deposit', entityId: deposit.id, category: 'recu',
      fichier: { buffer: contenu, type: 'pdf', mime: 'application/pdf', nomOrigine: `restitution-caution-${lease.reference}.pdf` },
      visibleToTenant: true, uploadedBy: user.id,
    }, t);
    await mouvement.update({ receipt_document_id: recu.id }, { transaction: t });
    await journaliser({ action: 'caution.restitution', entityType: 'deposit', entityId: deposit.id, ownerId, details: { montant: donnees.amount, retenu: deposit.amount_withheld, statut: deposit.status } }, t);
    await notifier(t, {
      destinataires: [destinataireLocataire(tenant)], ownerId, type: 'caution',
      titre: 'Restitution de caution', corps: `${formatFcfa(donnees.amount)} vous ont été restitués. Montant retenu : ${formatFcfa(deposit.amount_withheld)}.`,
      donnees: { deposit_id: deposit.id, document_id: recu.id },
      whatsapp: { evenement: 'caution_restitution', parametres: [formatFcfa(donnees.amount), formatFcfa(deposit.amount_withheld)] },
    });
    return { deposit, transaction: mouvement };
  });
}

/**
 * Réponse du propriétaire à une contestation (§ 55.3 « réponse du
 * propriétaire, issue ») : retenue maintenue (le litige reste, documenté),
 * annulée ou ajustée.
 */
async function repondreContestation(ownerId, id, transactionId, { response, outcome, adjusted_amount: ajuste }) {
  return operer(ownerId, id, async ({ t, deposit, tenant }) => {
    const tr = await DepositTransaction.findByPk(transactionId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!tr || tr.deposit_id !== deposit.id) throw new ValidationError('Données invalides', ['Retenue introuvable pour cette caution']);
    if (tr.contest_status !== 'conteste') throw new ConflictError("Cette retenue n'est pas en attente de réponse.", 'CONTESTATION_ABSENTE');
    if (outcome === 'ajustee' && !(ajuste >= 0 && ajuste < tr.amount)) {
      throw new ValidationError('Données invalides', ['Le montant ajusté doit être inférieur à la retenue initiale']);
    }
    await tr.update({
      owner_response: response, contest_outcome: outcome, contest_status: outcome, contest_resolved_at: new Date(),
      adjusted_amount: outcome === 'ajustee' ? ajuste : null,
    }, { transaction: t });
    await recalculer(t, deposit);
    await journaliser({ action: 'caution.reponse_contestation', entityType: 'deposit', entityId: deposit.id, ownerId, details: { retenue: tr.id, issue: outcome, montant_ajuste: ajuste ?? null } }, t);
    await notifier(t, {
      destinataires: [destinataireLocataire(tenant)], ownerId, type: 'caution',
      titre: 'Réponse à votre contestation', corps: `Votre contestation a reçu une réponse : ${response}`,
      donnees: { deposit_id: deposit.id, deposit_transaction_id: tr.id },
    });
    return { deposit, transaction: tr };
  });
}

// ── Espace locataire ─────────────────────────────────────────────────────────

async function listerPourLocataire(tenantIds) {
  const cautions = await Deposit.findAll({
    where: { tenant_id: { [Op.in]: tenantIds } },
    include: [...INCLUDE.slice(1), { model: DepositTransaction, as: 'transactions', separate: true, order: [['created_at', 'ASC']] }],
    order: [['created_at', 'DESC']],
  });
  return cautions.map((d) => ({ ...d.toJSON(), balance: solde(d) }));
}

/** § 55.3 — contestation d'une retenue par le locataire. */
async function contester(user, tenantIds, transactionId, { message }) {
  return sequelize.transaction(async (t) => {
    // Ordre des verrous IDENTIQUE à toutes les opérations de caution (operer →
    // repondreContestation) : la CAUTION d'abord, puis la retenue. L'ordre
    // inverse (retenue puis caution) croisé avec une réponse du propriétaire
    // produirait un interblocage (40P01). La retenue est donc d'abord lue sans
    // verrou, seulement pour trouver sa caution.
    const repere = await DepositTransaction.findByPk(transactionId, { attributes: ['id', 'deposit_id'], transaction: t });
    if (!repere) throw new ValidationError('Données invalides', ['Retenue introuvable']);
    const deposit = await chargerPourLocataire(Deposit, repere.deposit_id, tenantIds, { transaction: t, lock: t.LOCK.UPDATE }, 'Caution');
    const tr = await DepositTransaction.findByPk(transactionId, { transaction: t, lock: t.LOCK.UPDATE });
    if (tr.type !== 'retenue') throw new ConflictError('Seule une retenue peut être contestée.', 'CONTESTATION_IMPOSSIBLE');
    if (tr.contest_status) throw new ConflictError('Cette retenue a déjà été contestée.', 'DEJA_CONTESTEE');
    await tr.update({ contest_status: 'conteste', contest_message: message, contested_at: new Date() }, { transaction: t });
    await recalculer(t, deposit);
    await journaliser({ action: 'caution.contestation', entityType: 'deposit', entityId: deposit.id, ownerId: deposit.owner_id, details: { retenue: tr.id } }, t);
    await notifier(t, {
      destinataires: await destinatairesProprietaire(deposit.owner_id, t), ownerId: deposit.owner_id, type: 'caution',
      titre: 'Retenue contestée', corps: `Le locataire conteste une retenue de ${formatFcfa(tr.amount)} : ${message.slice(0, 200)}`,
      donnees: { deposit_id: deposit.id, deposit_transaction_id: tr.id },
    });
    return { deposit, transaction: tr };
  });
}

/**
 * Alerte de restitution (§ 55.4 « délai de restitution configurable ») : les
 * cautions en décompte dont l'échéance de restitution est dépassée — rappel à
 * J+1, J+7, J+14 puis J+30 (pas un message par jour).
 */
const RAPPELS_RESTITUTION = new Set([1, 7, 14, 30]);
async function alertesRestitution(jour = aujourdhui()) {
  const echues = await Deposit.findAll({
    where: { status: { [Op.in]: ['restitution_en_cours', 'retenue_partielle'] }, refund_due_date: { [Op.lt]: jour } },
    include: [{ model: Lease, as: 'lease', attributes: ['id', 'reference'] }],
  });
  for (const d of echues) {
    if (solde(d) <= 0 || !RAPPELS_RESTITUTION.has(ecartJours(d.refund_due_date, jour))) continue;
    await sequelize.transaction(async (t) => notifier(t, {
      destinataires: await destinatairesProprietaire(d.owner_id, t), ownerId: d.owner_id, type: 'caution',
      titre: 'Caution à restituer', corps: `Le délai de restitution de la caution du bail ${d.lease.reference} est dépassé (${formatFcfa(solde(d))} à restituer).`,
      donnees: { deposit_id: d.id },
    }));
  }
  return echues.length;
}

module.exports = {
  statutCaution, montantRetenu, lister, detail, verser, ajouterJustificatif, retenir, restituer, repondreContestation,
  listerPourLocataire, contester, alertesRestitution,
};
