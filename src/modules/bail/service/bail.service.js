'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Lease, Apartment, Building, Tenant, Deposit, DepositTransaction, RentSchedule, Inspection, LeaseDocument,
} = require('../../../models/index.js');
const { MOIS_PAR_PERIODICITE } = require('../../../config/enums.js');
const { chargerPourProprietaire, verifierReference } = require('../../../utils/acces.js');
const { ordre } = require('../../../utils/liste.js');
const { prochainNumero, pad } = require('../../../utils/compteur.js');
const { aujourdhui, ajouterJours, formatFr } = require('../../../utils/dates.js');
const { ConflictError, ValidationError } = require('../../../errors/AppError.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const echeances = require('../../loyer/service/echeance.service.js');
const parametres = require('../../parametres/service/parametres.service.js');
const droits = require('../../abonnement/service/droits.service.js');
const documents = require('../../document/service/document.service.js');
const modeles = require('./modeleBail.service.js');
const { notifier, destinataireLocataire, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Contrats de location (§ 10) et leur cycle de vie :
 *
 *   brouillon ──activer──▶ actif ──terminer──▶ termine ──clôturer──▶ clos
 *       └──annuler──▶ annule
 *
 * - activer : appartement libre (verrou de ligne + index unique « un bail
 *   actif par appartement »), état des lieux d'entrée selon la politique du
 *   propriétaire (§ 52.4), échéances générées (§ 10), caution « attendue »
 *   (§ 55), appartement « occupé » (§ 41) ;
 * - terminer : échéances postérieures à la sortie annulées (si non encaissées),
 *   appartement libéré, décompte de caution lancé avec son délai de
 *   restitution et une alerte au propriétaire (§ 55.4) ;
 * - clôturer : seulement si la caution est restituée ou le litige documenté
 *   (§ 55.4).
 */

const INCLUDE_DETAIL = [
  { model: Apartment, as: 'apartment', attributes: ['id', 'number', 'floor', 'type', 'status', 'building_id'], paranoid: false, include: [{ model: Building, as: 'building', attributes: ['id', 'name', 'city'], paranoid: false }] },
  { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone', 'email', 'user_id'], paranoid: false },
  { model: Deposit, as: 'deposit' },
];

const CHAMPS_BROUILLON = [
  'lease_type', 'start_date', 'end_date', 'rent_amount', 'charges_amount', 'deposit_amount', 'periodicity',
  'due_day', 'occupants_count', 'special_conditions', 'rent_revision_rule', 'notice_period_months',
];

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['status', 'tenant_id', 'apartment_id']) if (f[cle]) where[cle] = f[cle];
  const include = INCLUDE_DETAIL.slice(0, 2).map((i) => ({ ...i }));
  if (f.building_id) include[0] = { ...include[0], required: true, where: { building_id: f.building_id } };
  return Lease.findAndCountAll({ where, include, order: ordre(f.tri, '-start_date'), limit, offset });
}

async function detail(id, ownerId) {
  const lease = await chargerPourProprietaire(Lease, id, ownerId, { include: INCLUDE_DETAIL }, 'Bail');
  const [contrats, edl, soldes, pieces] = await Promise.all([
    LeaseDocument.findAll({ where: { lease_id: id }, attributes: ['id', 'version', 'template_version', 'document_id', 'special_clauses', 'shared_at', 'created_at'], order: [['version', 'DESC']] }),
    Inspection.findAll({ where: { lease_id: id, status: { [Op.ne]: 'remplace' } }, attributes: ['id', 'type', 'version', 'status', 'performed_at', 'accepted_at'] }),
    RentSchedule.findAll({
      where: { lease_id: id },
      attributes: [
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.literal("CASE WHEN status IN ('a_payer','partiellement_paye','en_retard') THEN amount_due - amount_paid ELSE 0 END")), 0), 'reste_du'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.literal('amount_paid')), 0), 'total_encaisse'],
      ],
      raw: true,
    }),
    documents.listerPourEntite('lease', id),
  ]);
  return { ...lease.toJSON(), contracts: contrats, inspections: edl, balance: soldes[0], documents: pieces.map(documents.versApi) };
}

async function creer(ownerId, user, donnees) {
  return sequelize.transaction(async (t) => {
    const apartment = await verifierReference(Apartment, donnees.apartment_id, ownerId, 'Appartement', { transaction: t });
    await verifierReference(Tenant, donnees.tenant_id, ownerId, 'Locataire', { transaction: t });
    const annee = aujourdhui().slice(0, 4);
    const numero = await prochainNumero(`owner:${ownerId}:lease:${annee}`, t);
    const lease = await Lease.create({
      ...donnees,
      rent_amount: donnees.rent_amount ?? apartment.rent_amount,
      charges_amount: donnees.charges_amount ?? apartment.charges_amount,
      lease_type: donnees.lease_type || (apartment.is_furnished ? 'meuble' : 'habitation'),
      owner_id: ownerId,
      reference: `BAIL-${annee}-${pad(numero, 4)}`,
      status: 'brouillon',
      created_by: user.id,
    }, { transaction: t });
    await journaliser({
      action: 'bail.creation', entityType: 'lease', entityId: lease.id, ownerId,
      details: { reference: lease.reference, apartment_id: lease.apartment_id, tenant_id: lease.tenant_id, loyer: lease.rent_amount, caution: lease.deposit_amount },
    }, t);
    return lease;
  });
}

async function modifier(id, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    if (lease.status !== 'brouillon') {
      throw new ConflictError('Seul un bail en brouillon est modifiable. Pour un bail actif, utilisez la modification de loyer.', 'BAIL_NON_MODIFIABLE');
    }
    const fusion = { ...lease.toJSON(), ...donnees };
    if (fusion.end_date && fusion.end_date <= fusion.start_date) throw new ValidationError('Données invalides', ['La date de fin doit être postérieure à la date de début']);
    const avant = lease.toJSON();
    await lease.update(donnees, { transaction: t, fields: CHAMPS_BROUILLON });
    await journaliser({ action: 'bail.modification', entityType: 'lease', entityId: id, ownerId, details: difference(avant, donnees, CHAMPS_BROUILLON) }, t);
    return lease;
  });
}

/**
 * Active le bail. Retourne `{ lease, avertissements }` : avec la politique
 * « avertissement », l'absence d'état des lieux d'entrée n'empêche pas
 * l'activation mais est signalée.
 */
async function activer(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    if (lease.status !== 'brouillon') throw new ConflictError(`Un bail « ${lease.status} » ne peut pas être activé.`, 'TRANSITION_INVALIDE');

    const apartment = await Apartment.findByPk(lease.apartment_id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!apartment) throw new ConflictError("L'appartement de ce bail a été supprimé.", 'APPARTEMENT_SUPPRIME');
    if (['indisponible', 'en_travaux'].includes(apartment.status)) {
      throw new ConflictError(`L'appartement est « ${apartment.status === 'en_travaux' ? 'en travaux' : 'indisponible'} » : rendez-le disponible avant d'activer le bail.`, 'APPARTEMENT_NON_DISPONIBLE');
    }
    const occupe = await Lease.count({ where: { apartment_id: apartment.id, status: 'actif' }, transaction: t });
    if (occupe) throw new ConflictError("L'appartement est déjà occupé par un bail actif.", 'APPARTEMENT_OCCUPE');

    // Fiche locataire supprimée (logiquement) après la création du brouillon :
    // un bail actif ne peut pas viser un locataire introuvable dans les listes.
    const locataire = await Tenant.findByPk(lease.tenant_id, { attributes: ['id'], transaction: t });
    if (!locataire) throw new ConflictError("Le locataire de ce bail a été supprimé.", 'LOCATAIRE_SUPPRIME');

    const reglages = await parametres.proprietaire(ownerId, t);
    const avertissements = [];
    if (reglages.entry_inspection_policy !== 'desactive') {
      const edl = await Inspection.count({ where: { lease_id: id, type: 'entree', status: { [Op.in]: ['soumis', 'accepte'] } }, transaction: t });
      if (!edl) {
        const message = "Aucun état des lieux d'entrée n'a été soumis au locataire pour ce bail (§ 52.4).";
        if (reglages.entry_inspection_policy === 'bloquant') throw new ConflictError(message, 'ETAT_DES_LIEUX_ENTREE_REQUIS');
        avertissements.push({ code: 'ETAT_DES_LIEUX_ENTREE_ABSENT', message });
      }
    }

    await lease.update({ status: 'actif', activated_at: new Date() }, { transaction: t });
    await apartment.update({ status: 'occupe' }, { transaction: t });
    const nb = await echeances.generer(lease, reglages, t);
    if (lease.deposit_amount > 0) {
      await Deposit.create({ owner_id: ownerId, lease_id: id, tenant_id: lease.tenant_id, amount_expected: lease.deposit_amount, status: 'attendue' }, { transaction: t });
    }
    await journaliser({
      action: 'bail.changement_statut', entityType: 'lease', entityId: id, ownerId,
      details: { avant: 'brouillon', apres: 'actif', echeances_generees: nb, avertissements: avertissements.map((a) => a.code) },
    }, t);
    return { lease, avertissements };
  });
}

async function annuler(id, ownerId, motif) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    if (lease.status !== 'brouillon') throw new ConflictError('Seul un bail en brouillon peut être annulé. Un bail actif se termine.', 'TRANSITION_INVALIDE');
    await lease.update({ status: 'annule', cancelled_at: new Date(), termination_reason: motif }, { transaction: t });
    await journaliser({ action: 'bail.changement_statut', entityType: 'lease', entityId: id, ownerId, details: { avant: 'brouillon', apres: 'annule', motif } }, t);
    return lease;
  });
}

/** Fin du bail (départ du locataire). */
async function terminer(id, ownerId, { ended_on: dateSortie, termination_reason: motif }) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    if (lease.status !== 'actif') throw new ConflictError('Seul un bail actif peut être terminé.', 'TRANSITION_INVALIDE');
    if (dateSortie < lease.start_date) throw new ValidationError('Données invalides', ['La date de sortie précède le début du bail']);

    // Échéances des périodes qui commencent après la sortie : annulées si
    // aucun paiement ne les concerne (un loyer encaissé n'est jamais effacé).
    const [annulees] = await RentSchedule.update(
      { status: 'annule', cancelled_at: new Date(), cancel_reason: 'Fin du bail' },
      {
        where: {
          lease_id: id,
          period_start: { [Op.gt]: dateSortie },
          amount_paid: 0,
          status: { [Op.ne]: 'annule' },
          // Paiement Wave / Orange Money en cours sur l'échéance : elle reste
          // ouverte, la confirmation du fournisseur doit pouvoir s'y imputer.
          id: { [Op.notIn]: sequelize.literal("(SELECT rent_schedule_id FROM payment_transactions WHERE rent_schedule_id IS NOT NULL AND status IN ('initiee', 'en_attente'))") },
        },
        transaction: t,
      }
    );

    await lease.update({ status: 'termine', ended_on: dateSortie, termination_reason: motif || null }, { transaction: t });
    await Apartment.update({ status: 'disponible' }, { where: { id: lease.apartment_id }, transaction: t });

    const reglages = await parametres.proprietaire(ownerId, t);
    const deposit = await Deposit.findOne({ where: { lease_id: id }, transaction: t, lock: t.LOCK.UPDATE });
    if (deposit) {
      await deposit.update({
        refund_due_date: ajouterJours(dateSortie, reglages.deposit_refund_days),
        settlement_started_at: new Date(),
        status: deposit.amount_received > 0 ? 'restitution_en_cours' : deposit.status,
      }, { transaction: t });
    }

    await journaliser({ action: 'bail.changement_statut', entityType: 'lease', entityId: id, ownerId, details: { avant: 'actif', apres: 'termine', date_sortie: dateSortie, echeances_annulees: annulees } }, t);

    // § 55.4 — alerte au propriétaire pour lancer le décompte de la caution.
    if (deposit && deposit.amount_received > 0) {
      await notifier(t, {
        destinataires: await destinatairesProprietaire(ownerId, t),
        ownerId,
        type: 'caution',
        titre: 'Décompte de caution à préparer',
        corps: `Le bail ${lease.reference} est terminé. Caution détenue à restituer avant le ${formatFr(deposit.refund_due_date)} (après l'état des lieux de sortie).`,
        donnees: { lease_id: id, deposit_id: deposit.id },
      });
    }
    return lease;
  });
}

/** Clôture définitive — § 55.4 « caution restituée ou litige documenté ». */
async function cloturer(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    if (lease.status !== 'termine') throw new ConflictError('Seul un bail terminé peut être clôturé.', 'TRANSITION_INVALIDE');
    // Verrou (ordre bail → caution, comme `terminer`) : une contestation ou une
    // retenue concurrente ne s'intercale pas entre le contrôle et la clôture.
    const deposit = await Deposit.findOne({ where: { lease_id: id }, transaction: t, lock: t.LOCK.UPDATE });
    if (deposit) {
      const solde = deposit.amount_received - deposit.amount_withheld - deposit.amount_refunded;
      // Litige « documenté » : chaque contestation a reçu la réponse et l'issue
      // du propriétaire (§ 55.3). Tant qu'une contestation attend, pas de clôture.
      const enAttente = await DepositTransaction.count({ where: { deposit_id: deposit.id, contest_status: 'conteste' }, transaction: t });
      const litigeDocumente = deposit.status === 'litige' && enAttente === 0;
      const solde0 = solde === 0 && deposit.status !== 'litige';
      if (!(deposit.status === 'restituee' || solde0 || litigeDocumente)) {
        throw new ConflictError(
          'Le bail ne peut être clôturé qu’une fois la caution restituée ou le litige documenté (réponse du propriétaire à chaque contestation).',
          'CAUTION_NON_SOLDEE',
          { statut_caution: deposit.status, solde }
        );
      }
    }
    await lease.update({ status: 'clos', closed_at: new Date() }, { transaction: t });
    await journaliser({ action: 'bail.changement_statut', entityType: 'lease', entityId: id, ownerId, details: { avant: 'termine', apres: 'clos' } }, t);
    return lease;
  });
}

/**
 * Modification du loyer d'un bail actif (§ 40 « modification de loyer »).
 * Les échéances NON ENCAISSÉES commençant à partir de la date d'effet sont
 * recalculées ; les autres restent intactes (historique financier).
 */
async function modifierLoyer(id, ownerId, { rent_amount: loyer, charges_amount: charges, effective_from: effet }) {
  return sequelize.transaction(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    if (lease.status !== 'actif') throw new ConflictError('Seul le loyer d’un bail actif se modifie ainsi.', 'TRANSITION_INVALIDE');
    // Pas de révision rétroactive : un impayé déjà échu (et relancé) garde son montant.
    if (effet < aujourdhui()) throw new ValidationError('Données invalides', ["La date d'effet ne peut pas être antérieure à aujourd'hui"], 'DATE_EFFET_PASSEE');
    const avant = { rent_amount: lease.rent_amount, charges_amount: lease.charges_amount };
    const nouveau = { rent_amount: loyer ?? lease.rent_amount, charges_amount: charges ?? lease.charges_amount };
    await lease.update(nouveau, { transaction: t });

    const aRecalculer = await RentSchedule.findAll({
      where: { lease_id: id, period_start: { [Op.gte]: effet }, amount_paid: 0, status: { [Op.in]: ['a_venir', 'a_payer'] } },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const mois = MOIS_PAR_PERIODICITE[lease.periodicity];
    for (const e of aRecalculer) {
      // Période pleine : nouveau montant × mois ; période proratisée : même ratio qu'avant.
      const ratio = e.rent_amount + e.charges_amount > 0 && avant.rent_amount + avant.charges_amount > 0
        ? (e.rent_amount + e.charges_amount) / ((avant.rent_amount + avant.charges_amount) * mois)
        : 1;
      const rent = Math.round(nouveau.rent_amount * mois * ratio);
      const ch = Math.round(nouveau.charges_amount * mois * ratio);
      await e.update({ rent_amount: rent, charges_amount: ch, amount_due: rent + ch }, { transaction: t });
    }
    await journaliser({
      action: 'bail.modification_loyer', entityType: 'lease', entityId: id, ownerId,
      details: { avant, apres: nouveau, date_effet: effet, echeances_recalculees: aRecalculer.length },
    }, t);
    return { lease, echeances_recalculees: aRecalculer.length };
  });
}

/**
 * Génère le contrat PDF depuis le modèle publié (§ 53.4), le range dans les
 * documents, le partage avec le locataire et le notifie.
 */
async function genererContrat(id, ownerId, user, { special_clauses: clauses }) {
  await droits.exigerFonctionnalite(ownerId, 'modeles_bail');
  return transactionAvecFichiers(async (t) => {
    const lease = await chargerPourProprietaire(Lease, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Bail');
    if (['annule', 'clos'].includes(lease.status)) throw new ConflictError(`Impossible de générer le contrat d'un bail « ${lease.status} ».`, 'TRANSITION_INVALIDE');
    const modele = await modeles.modelePublie(lease.lease_type, t);
    const texte = modeles.rendre(modele.body, await modeles.contexte(lease, t));
    const version = await modeles.prochaineVersion(id, t);
    const contenuPdf = await modeles.pdfContrat({
      titre: modele.title, texte, clauses: clauses || null, reference: lease.reference, versionModele: modele.version,
    });

    const tenant = await Tenant.findByPk(lease.tenant_id, { transaction: t, paranoid: false });
    const document = await documents.creerDocument({
      ownerId, tenantId: lease.tenant_id, entityType: 'lease', entityId: id, category: 'contrat',
      fichier: { buffer: contenuPdf, type: 'pdf', mime: 'application/pdf', nomOrigine: `${lease.reference}-v${version}.pdf` },
      visibleToTenant: true, uploadedBy: user.id,
    }, t);
    const contrat = await LeaseDocument.create({
      owner_id: ownerId, lease_id: id, template_id: modele.id, template_version: modele.version, version,
      content: texte, special_clauses: clauses || null, document_id: document.id, generated_by: user.id, shared_at: new Date(),
    }, { transaction: t });
    await journaliser({ action: 'bail.generation_contrat', entityType: 'lease', entityId: id, ownerId, details: { version, modele_version: modele.version, clauses_particulieres: Boolean(clauses) } }, t);
    await notifier(t, {
      destinataires: [destinataireLocataire(tenant)], ownerId, type: 'document_disponible',
      titre: 'Votre contrat de bail est disponible', corps: `Le contrat ${lease.reference} est disponible dans votre espace.`,
      donnees: { lease_id: id, document_id: document.id },
    });
    return { contrat, document: documents.versApi(document) };
  });
}

/** Documents générés d'un bail (historique des versions de contrat). */
async function contrats(id, ownerId) {
  await chargerPourProprietaire(Lease, id, ownerId, { attributes: ['id', 'owner_id'] }, 'Bail');
  return LeaseDocument.findAll({
    where: { lease_id: id },
    attributes: ['id', 'version', 'template_version', 'special_clauses', 'shared_at', 'created_at', 'document_id'],
    order: [['version', 'DESC']],
  });
}

module.exports = { lister, detail, creer, modifier, activer, annuler, terminer, cloturer, modifierLoyer, genererContrat, contrats };
