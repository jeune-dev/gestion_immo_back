'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  WorkOrder, WorkOrderEvent, WorkPhoto, Building, Apartment, Contractor, Incident, Expense, ExpenseCategory, Document,
} = require('../../../models/index.js');
const { TRAVAUX, verifierTransition } = require('../../../config/transitions.js');
const { STATUT_TRAVAUX } = require('../../../config/enums.js');
const { chargerPourProprietaire, verifierReference } = require('../../../utils/acces.js');
const { ordre, rechercheTexte } = require('../../../utils/liste.js');
const { prochainNumero, pad } = require('../../../utils/compteur.js');
const { ajouterJours } = require('../../../utils/dates.js');
const { ConflictError, NotFoundError, ValidationError } = require('../../../errors/AppError.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const documents = require('../../document/service/document.service.js');
const depenses = require('../../depense/service/depense.service.js');
const { appliquerStatut, transitionPermise } = require('../../incident/service/incidentStatut.service.js');
const { notifier, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Travaux (§ 18) et photos d'intervention (§ 19).
 *
 *   signale → a_valider → valide → artisan_assigne → en_cours → termine
 *                                                  (annule depuis tout statut ouvert)
 *
 * - Transitions STRICTEMENT selon `config/transitions.js#TRAVAUX`, chacune
 *   historisée dans `work_order_events` + audit (§ 25, § 40).
 * - « Une intervention terminée doit conserver son historique » (§ 41) : un
 *   travail terminé ou annulé est IMMUABLE (ni modification, ni retrait de
 *   photo) ; seules les preuves s'ajoutent (photos, dépenses).
 * - La clôture d'un chantier lié à un incident résout l'incident et prévient
 *   le locataire (§ 23 étape 8, § 54.2).
 */

const STATUTS_CLOS = ['termine', 'annule'];
const CHAMPS = ['title', 'description', 'apartment_id', 'category', 'priority', 'estimated_amount', 'actual_amount', 'contractor_id', 'scheduled_for'];

const INCLUDE_LISTE = [
  { model: Building, as: 'building', attributes: ['id', 'name'], paranoid: false },
  { model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false },
  { model: Contractor, as: 'contractor', attributes: ['id', 'name', 'phone', 'trade'], paranoid: false },
];
const INCLUDE_DETAIL = [
  ...INCLUDE_LISTE,
  { model: Incident, as: 'incident', attributes: ['id', 'reference', 'title', 'status', 'tenant_id', 'category'] },
];

/** Numéro lisible « #00482 » (§ 19) à côté du numéro brut. */
const versApi = (wo) => ({ ...(wo.toJSON ? wo.toJSON() : wo), reference: `#${pad(wo.number)}` });
const libelle = (wo) => `Le travail #${pad(wo.number)}`;

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['status', 'priority', 'category', 'building_id', 'apartment_id', 'contractor_id', 'incident_id']) {
    if (f[cle]) where[cle] = f[cle];
  }
  const texte = rechercheTexte(f.q, ['title']);
  if (texte) Object.assign(where, texte);
  // Période sur la date de création (horodatage) : borne haute EXCLUSIVE au
  // lendemain, pour inclure toute la journée « au ».
  if (f.du || f.au) {
    where.created_at = {};
    if (f.du) where.created_at[Op.gte] = f.du;
    if (f.au) where.created_at[Op.lt] = ajouterJours(f.au, 1);
  }
  const { rows, count } = await WorkOrder.findAndCountAll({ where, include: INCLUDE_LISTE, order: ordre(f.tri, '-created_at'), limit, offset });
  return { rows: rows.map(versApi), count };
}

/** Photos d'un chantier regroupées par phase (§ 19 avant / pendant / après). */
async function photosGroupees(workOrderId) {
  const photos = await WorkPhoto.findAll({
    where: { work_order_id: workOrderId },
    include: [{ model: Document, as: 'document', required: true }],
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  });
  const groupes = { avant: [], pendant: [], apres: [] };
  for (const p of photos) {
    groupes[p.phase].push({
      id: p.id, phase: p.phase, caption: p.caption, captured_at: p.captured_at, created_at: p.created_at,
      document: documents.versApi(p.document),
    });
  }
  return groupes;
}

/**
 * Fiche complète : historique, photos, dépenses — requêtes en nombre FIXE
 * (les hasMany ne sont pas joints ensemble : produit cartésien évité).
 */
async function detail(id, ownerId) {
  const wo = await chargerPourProprietaire(WorkOrder, id, ownerId, { include: INCLUDE_DETAIL }, 'Travaux');
  const [events, photos, expenses] = await Promise.all([
    WorkOrderEvent.findAll({ where: { work_order_id: id }, order: [['created_at', 'ASC'], ['id', 'ASC']] }),
    photosGroupees(id),
    Expense.findAll({
      where: { work_order_id: id, owner_id: ownerId },
      attributes: ['id', 'amount', 'method', 'spent_on', 'description', 'status', 'contractor_id', 'created_at'],
      include: [{ model: ExpenseCategory, as: 'category', attributes: ['id', 'code', 'name'] }],
      order: [['spent_on', 'ASC'], ['id', 'ASC']],
    }),
  ]);
  const totalDepenses = expenses.filter((e) => e.status === 'valide').reduce((s, e) => s + e.amount, 0);
  return { ...versApi(wo), events, photos, expenses, total_expenses: totalDepenses };
}

async function verifierArtisan(contractorId, ownerId, t) {
  const contractor = await verifierReference(Contractor, contractorId, ownerId, 'Artisan', { transaction: t });
  if (!contractor.is_active) throw new ConflictError('Cet artisan est désactivé : réactivez-le ou choisissez-en un autre.', 'ARTISAN_INACTIF');
  return contractor;
}

async function verifierAppartement(apartmentId, buildingId, ownerId, t) {
  const apartment = await verifierReference(Apartment, apartmentId, ownerId, 'Appartement', { transaction: t });
  if (apartment.building_id !== buildingId) {
    throw new ValidationError('Données invalides', ["L'appartement n'appartient pas à l'immeuble des travaux"]);
  }
  return apartment;
}

const recharger = (id, ownerId) => chargerPourProprietaire(WorkOrder, id, ownerId, { include: INCLUDE_DETAIL }, 'Travaux').then(versApi);

/**
 * Création dans la transaction de l'appelant (utilisée aussi par « créer les
 * travaux depuis l'incident »). Numéro par propriétaire, sans trou.
 *
 * @param {object|null} incident  incident verrouillé à l'origine du chantier
 */
async function creerDansTransaction(t, ownerId, user, d, incident = null) {
  const building = await verifierReference(Building, d.building_id, ownerId, 'Immeuble', { transaction: t });
  if (d.apartment_id) await verifierAppartement(d.apartment_id, building.id, ownerId, t);
  if (d.contractor_id) await verifierArtisan(d.contractor_id, ownerId, t);

  const numero = await prochainNumero(`owner:${ownerId}:work_order`, t);
  const statut = d.status || 'signale';
  const wo = await WorkOrder.create({
    owner_id: ownerId,
    number: numero,
    building_id: building.id,
    apartment_id: d.apartment_id || null,
    incident_id: incident ? incident.id : null,
    contractor_id: d.contractor_id || null,
    title: d.title,
    description: d.description || null,
    category: d.category,
    priority: d.priority || 'normale',
    status: statut,
    estimated_amount: d.estimated_amount ?? null,
    scheduled_for: d.scheduled_for || null,
    created_by: user.id,
  }, { transaction: t });

  // Premier événement de l'historique : la création elle-même.
  await WorkOrderEvent.create({
    work_order_id: wo.id, from_status: null, to_status: statut,
    comment: incident ? `Créé depuis l'incident ${incident.reference}` : 'Création', user_id: user.id,
  }, { transaction: t });
  await journaliser({
    action: 'travaux.creation', entityType: 'work_order', entityId: wo.id, ownerId,
    details: { numero: wo.number, titre: wo.title, statut, building_id: wo.building_id, apartment_id: wo.apartment_id, incident_id: wo.incident_id },
  }, t);

  // § 27 « Nouveau travail » : les AUTRES membres de l'espace.
  const destinataires = (await destinatairesProprietaire(ownerId, t)).filter((x) => x.userId !== user.id);
  if (destinataires.length) {
    await notifier(t, {
      destinataires, ownerId, type: 'nouveau_travail',
      titre: `Nouveau travail #${pad(wo.number)}`,
      corps: wo.title,
      donnees: { work_order_id: wo.id },
    });
  }
  return wo;
}

async function creer(ownerId, user, donnees) {
  const wo = await sequelize.transaction((t) => creerDansTransaction(t, ownerId, user, donnees));
  return recharger(wo.id, ownerId);
}

function exigerOuvert(wo) {
  if (STATUTS_CLOS.includes(wo.status)) {
    throw new ConflictError(`${libelle(wo)} est « ${STATUT_TRAVAUX[wo.status]} » : il n'est plus modifiable (historique conservé).`, 'TRAVAUX_CLOTURES');
  }
}

async function modifier(id, ownerId, donnees) {
  await sequelize.transaction(async (t) => {
    const wo = await chargerPourProprietaire(WorkOrder, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Travaux');
    exigerOuvert(wo);
    if (donnees.apartment_id) await verifierAppartement(donnees.apartment_id, wo.building_id, ownerId, t);
    if (donnees.contractor_id) await verifierArtisan(donnees.contractor_id, ownerId, t);
    if (donnees.contractor_id === null && ['artisan_assigne', 'en_cours'].includes(wo.status)) {
      throw new ValidationError('Données invalides', ["L'artisan ne peut pas être retiré d'un travail qui lui est assigné : repassez-le d'abord au statut « validé »"]);
    }
    const avant = wo.toJSON();
    await wo.update(donnees, { transaction: t, fields: CHAMPS });
    await journaliser({ action: 'travaux.modification', entityType: 'work_order', entityId: id, ownerId, details: difference(avant, donnees, CHAMPS) }, t);
  });
  return recharger(id, ownerId);
}

/**
 * Répercussion sur l'incident d'origine, quand ce chantier était le DERNIER
 * encore ouvert pour cet incident :
 *   - travail terminé → incident résolu, locataire prévenu « travail terminé » ;
 *   - travail annulé  → si un autre chantier de l'incident a abouti, résolu ;
 *                       sinon retour « en analyse » (le propriétaire doit
 *                       décider d'une autre solution).
 * Toujours dans le respect de la table INCIDENT (sinon, rien).
 */
async function repercuterSurIncident(t, wo, vers) {
  if (!wo.incident_id) return;
  const incident = await Incident.findByPk(wo.incident_id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!incident) return;
  const autres = await WorkOrder.findAll({
    where: { incident_id: incident.id, id: { [Op.ne]: wo.id } }, attributes: ['status'], transaction: t,
  });
  if (autres.some((a) => !STATUTS_CLOS.includes(a.status))) return;

  const abouti = vers === 'termine' || autres.some((a) => a.status === 'termine');
  if (abouti && transitionPermise(incident, 'resolu')) {
    await appliquerStatut(t, incident, 'resolu', {
      notification: {
        type: 'travail_termine',
        titre: `Travaux terminés — ${incident.reference}`,
        corps: `Les travaux liés à votre demande « ${incident.title} » sont terminés. Votre demande est résolue.`,
      },
    });
  } else if (!abouti && incident.status === 'travaux_planifies' && transitionPermise(incident, 'en_analyse')) {
    await appliquerStatut(t, incident, 'en_analyse');
  }
}

/**
 * Transition de statut (§ 18) :
 *   - artisan_assigne : un artisan (fourni ou déjà rattaché) est obligatoire ;
 *   - en_cours        : horodatage de début ;
 *   - termine         : date de clôture, montant réel facultatif ;
 *   - annule          : motif obligatoire.
 */
async function changerStatut(id, ownerId, user, { status: vers, comment, contractor_id: contractorId, actual_amount: montantReel }) {
  await sequelize.transaction(async (t) => {
    const wo = await chargerPourProprietaire(WorkOrder, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Travaux');
    const avant = wo.status;
    verifierTransition(TRAVAUX, avant, vers, libelle(wo));

    const champs = { status: vers };
    const maintenant = new Date();
    if (contractorId) {
      await verifierArtisan(contractorId, ownerId, t);
      champs.contractor_id = contractorId;
    }
    if (vers === 'artisan_assigne' && !(champs.contractor_id || wo.contractor_id)) {
      throw new ValidationError('Données invalides', ['contractor_id est obligatoire pour assigner un artisan']);
    }
    if (vers === 'en_cours' && !wo.started_at) champs.started_at = maintenant;
    if (vers === 'termine') {
      champs.completed_at = maintenant;
      if (montantReel !== undefined) champs.actual_amount = montantReel;
    }
    if (vers === 'annule') {
      if (!comment) throw new ValidationError('Données invalides', ["Le motif (comment) est obligatoire pour annuler des travaux"]);
      Object.assign(champs, { cancelled_at: maintenant, cancel_reason: comment });
    }
    await wo.update(champs, { transaction: t });

    await WorkOrderEvent.create({ work_order_id: id, from_status: avant, to_status: vers, comment: comment || null, user_id: user.id }, { transaction: t });
    await journaliser({
      action: 'travaux.changement_statut', entityType: 'work_order', entityId: id, ownerId,
      details: {
        numero: wo.number, avant, apres: vers, commentaire: comment || null,
        ...(champs.contractor_id ? { contractor_id: champs.contractor_id } : {}),
        ...(champs.actual_amount !== undefined ? { montant_reel: champs.actual_amount } : {}),
      },
    }, t);

    if (vers === 'termine') {
      const destinataires = (await destinatairesProprietaire(ownerId, t)).filter((x) => x.userId !== user.id);
      if (destinataires.length) {
        await notifier(t, {
          destinataires, ownerId, type: 'travail_termine',
          titre: `Travail #${pad(wo.number)} terminé`, corps: wo.title, donnees: { work_order_id: id },
        });
      }
    }
    if (STATUTS_CLOS.includes(vers)) await repercuterSurIncident(t, wo, vers);
  });
  return recharger(id, ownerId);
}

/** Photo d'intervention (§ 19) : document « photo » + ligne work_photos. */
async function ajouterPhoto(id, ownerId, user, fichier, { phase, caption, captured_at: prisLe }) {
  return transactionAvecFichiers(async (t) => {
    const wo = await chargerPourProprietaire(WorkOrder, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Travaux');
    // Un chantier terminé accepte encore ses photos « après » (preuve envoyée
    // après une synchronisation différée) ; un chantier annulé, non.
    if (wo.status === 'annule') throw new ConflictError('Des travaux annulés ne reçoivent plus de photo.', 'TRAVAUX_ANNULES');
    const document = await documents.creerDocument({
      ownerId, entityType: 'work_order', entityId: id, category: 'photo', fichier,
      capturedAt: prisLe || null, uploadedBy: user.id,
    }, t);
    const photo = await WorkPhoto.create({
      owner_id: ownerId, work_order_id: id, document_id: document.id, phase, caption: caption || null, captured_at: prisLe || null,
    }, { transaction: t });
    return {
      id: photo.id, phase, caption: photo.caption, captured_at: photo.captured_at, created_at: photo.created_at,
      document: documents.versApi(document),
    };
  });
}

async function photos(id, ownerId) {
  await chargerPourProprietaire(WorkOrder, id, ownerId, { attributes: ['id', 'owner_id'] }, 'Travaux');
  return photosGroupees(id);
}

/**
 * Retrait d'une photo (erreur de prise de vue) — interdit une fois le travail
 * terminé ou annulé : la preuve visuelle fait partie de l'historique (§ 19, § 41).
 * Le document est supprimé LOGIQUEMENT.
 */
async function supprimerPhoto(id, photoId, ownerId) {
  return sequelize.transaction(async (t) => {
    const wo = await chargerPourProprietaire(WorkOrder, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Travaux');
    if (STATUTS_CLOS.includes(wo.status)) {
      throw new ConflictError(`${libelle(wo)} est clôturé : ses photos sont conservées comme preuve.`, 'PHOTOS_VERROUILLEES');
    }
    const photo = await WorkPhoto.findOne({ where: { id: photoId, work_order_id: id }, transaction: t });
    if (!photo) throw new NotFoundError('Photo introuvable');
    await photo.destroy({ transaction: t });
    await Document.destroy({ where: { id: photo.document_id }, transaction: t });
    await journaliser({ action: 'travaux.suppression', entityType: 'work_order', entityId: id, ownerId, details: { photo_id: photoId, document_id: photo.document_id, phase: photo.phase } }, t);
  });
}

/** § 23 étape 7 — dépense du chantier (voir depense.service#creerPourTravaux). */
const ajouterDepense = (id, ownerId, user, donnees) => depenses.creerPourTravaux(id, ownerId, user, donnees);

module.exports = {
  lister, detail, creer, creerDansTransaction, modifier, changerStatut,
  ajouterPhoto, photos, supprimerPhoto, ajouterDepense, versApi,
};
