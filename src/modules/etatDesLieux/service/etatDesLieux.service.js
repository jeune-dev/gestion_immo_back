'use strict';

const crypto = require('crypto');
const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Inspection, InspectionRoom, InspectionItem, InspectionPhoto, Document, Lease, Apartment, Building, Tenant, Owner,
} = require('../../../models/index.js');
const { ETAT_DES_LIEUX, verifierTransition } = require('../../../config/transitions.js');
const { TYPE_ETAT_DES_LIEUX } = require('../../../config/enums.js');
const { chargerPourProprietaire, chargerPourLocataire, verifierReference } = require('../../../utils/acces.js');
const { ordre } = require('../../../utils/liste.js');
const { ConflictError, NotFoundError, ValidationError } = require('../../../errors/AppError.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const storage = require('../../../infrastructure/storage.service.js');
const logger = require('../../../utils/logger.js');
const parametres = require('../../parametres/service/parametres.service.js');
const documents = require('../../document/service/document.service.js');
const { notifier, destinataireLocataire, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');
const { trameDesPieces, elementsParDefaut } = require('./trame.service.js');
const { comparerEtatsDesLieux } = require('./comparaison.service.js');
const { genererPdf, dateHeure } = require('./pdfEtatDesLieux.service.js');

/**
 * États des lieux avec photos (§ 52).
 *
 *   brouillon ──soumettre──▶ soumis ──accepter (locataire / tacite)──▶ accepte
 *                               └──contester (locataire)──▶ conteste
 *   conteste | accepte ──corriger──▶ remplace  (+ nouvelle version en brouillon)
 *
 * - Seul le BROUILLON est modifiable. Un état des lieux accepté est immuable
 *   (§ 52.4, § 56.1) : toute écriture est refusée (409), la correction crée
 *   une nouvelle version (`previous_version_id`) tracée au journal d'audit.
 * - Une seule version « vivante » par bail et par type (index unique partiel
 *   `inspections_version_vivante_uq`) : l'ancienne version passe à
 *   « remplace » AVANT l'insertion de la nouvelle, dans la même transaction.
 * - L'acceptation (explicite ou tacite à l'échéance du délai configurable,
 *   § 52.3 étape 3) verrouille (`locked_at`) et ARCHIVE le PDF avec photos
 *   (§ 52.3 étape 4) dans les documents, visible du locataire.
 * - Saisie hors ligne (§ 52.4, § 34) : la saisie groupée `PUT /:id/saisie`
 *   rejoue en une requête tout ce qui a été relevé sans réseau ; la photo
 *   conserve l'horodatage de prise de vue (`captured_at`) ET l'horodatage
 *   serveur (`created_at`).
 */

const LIBELLE = 'État des lieux';
const PHOTOS_MAX_PAR_ELEMENT = 20;
const LOT_TACITE = 20;

/** Statuts du bail compatibles avec chaque type d'état des lieux. */
const STATUTS_BAIL = Object.freeze({
  entree: ['brouillon', 'actif'],
  sortie: ['actif', 'termine'],
});

/** Statuts visibles du locataire : jamais le brouillon, encore en préparation. */
const STATUTS_LOCATAIRE = ['soumis', 'accepte', 'conteste', 'remplace'];

const CHAMPS_ENTETE = ['performed_at', 'parties_present', 'water_meter', 'electricity_meter', 'keys_count', 'keys_details', 'general_observations'];

const INCLUDE_ENTETE = [
  { model: Lease, as: 'lease', attributes: ['id', 'reference', 'status', 'start_date', 'end_date'] },
  {
    model: Apartment, as: 'apartment', attributes: ['id', 'number', 'type', 'floor', 'is_furnished', 'building_id'], paranoid: false,
    include: [{ model: Building, as: 'building', attributes: ['id', 'name', 'address', 'city'], paranoid: false }],
  },
  { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name', 'phone', 'user_id'], paranoid: false },
];

const INCLUDE_LISTE = [
  { model: Lease, as: 'lease', attributes: ['id', 'reference', 'status'] },
  { model: Apartment, as: 'apartment', attributes: ['id', 'number', 'building_id'], paranoid: false },
  { model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name'], paranoid: false },
];

// ── Lecture de l'arbre pièces → éléments → photos ──────────────────────────

/**
 * Arbre complet en UNE requête (jointures), trié par position : jamais une
 * requête par pièce ou par élément (pas de N+1).
 * @returns {Promise<Array<{ id, name, position, notes, items: Array<{ ..., photos: Array<{ id, captured_at, created_at, document: Document|null }> }> }>>}
 */
async function chargerArbre(inspectionId, transaction) {
  const rooms = await InspectionRoom.findAll({
    where: { inspection_id: inspectionId },
    include: [{
      model: InspectionItem, as: 'items', required: false,
      include: [{
        model: InspectionPhoto, as: 'photos', required: false,
        include: [{ model: Document, as: 'document', required: false }],
      }],
    }],
    order: [
      ['position', 'ASC'], ['id', 'ASC'],
      [{ model: InspectionItem, as: 'items' }, 'position', 'ASC'],
      [{ model: InspectionItem, as: 'items' }, 'id', 'ASC'],
      [{ model: InspectionItem, as: 'items' }, { model: InspectionPhoto, as: 'photos' }, 'created_at', 'ASC'],
    ],
    transaction,
  });
  return rooms.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    notes: r.notes,
    items: (r.items || []).map((i) => ({
      id: i.id,
      room_id: i.room_id,
      element: i.element,
      label: i.label,
      condition: i.condition,
      comment: i.comment,
      position: i.position,
      // Une photo dont le document a été supprimé logiquement n'est plus exposée.
      photos: (i.photos || []).filter((p) => p.document).map((p) => ({
        id: p.id, captured_at: p.captured_at, created_at: p.created_at, document: p.document,
      })),
    })),
  }));
}

/** Arbre pour l'API : la clé de stockage ne sort jamais (documents.versApi). */
function arbreVersApi(rooms, { locataire = false } = {}) {
  return rooms.map((r) => ({
    ...r,
    items: r.items.map((i) => ({
      ...i,
      photos: i.photos
        .filter((p) => !locataire || p.document.visible_to_tenant)
        .map((p) => ({ id: p.id, captured_at: p.captured_at, created_at: p.created_at, document: documents.versApi(p.document) })),
    })),
  }));
}

async function versions(inspection, transaction) {
  return Inspection.findAll({
    where: { lease_id: inspection.lease_id, type: inspection.type },
    attributes: ['id', 'version', 'status', 'previous_version_id', 'submitted_at', 'accepted_at', 'contested_at', 'created_at'],
    order: [['version', 'DESC']],
    transaction,
  });
}

async function vueComplete(inspection, { locataire = false } = {}) {
  const [rooms, historique] = await Promise.all([chargerArbre(inspection.id), versions(inspection)]);
  const json = inspection.toJSON();
  // L'auteur interne (compte du propriétaire ou d'un membre) ne regarde pas le locataire.
  if (locataire) delete json.created_by;
  return {
    ...json,
    rooms: arbreVersApi(rooms, { locataire }),
    versions: locataire ? historique.filter((v) => v.status !== 'brouillon') : historique,
    pdf_url: json.document_id ? `/api/v1/documents/${json.document_id}/fichier` : null,
  };
}

// ── Gardes ─────────────────────────────────────────────────────────────────

function exigerBrouillon(inspection) {
  if (inspection.status === 'brouillon') return;
  const message = inspection.status === 'accepte'
    ? 'Un état des lieux accepté est immuable (§ 56.1) : utilisez « corriger » pour créer une nouvelle version.'
    : `Un état des lieux « ${inspection.status} » n'est plus modifiable : seul le brouillon l'est.`;
  throw new ConflictError(message, 'ETAT_DES_LIEUX_VERROUILLE', { statut: inspection.status });
}

/** Charge l'état des lieux avec VERROU DE LIGNE et exige le brouillon. */
async function chargerModifiable(id, ownerId, t) {
  const inspection = await chargerPourProprietaire(Inspection, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, LIBELLE);
  exigerBrouillon(inspection);
  return inspection;
}

async function chargerPiece(inspectionId, roomId, t) {
  const room = await InspectionRoom.findOne({ where: { id: roomId, inspection_id: inspectionId }, transaction: t });
  if (!room) throw new NotFoundError('Pièce introuvable dans cet état des lieux');
  return room;
}

async function chargerElement(inspectionId, itemId, t) {
  const item = await InspectionItem.findOne({ where: { id: itemId, inspection_id: inspectionId }, transaction: t });
  if (!item) throw new NotFoundError('Élément introuvable dans cet état des lieux');
  return item;
}

/** Documents des photos rattachées à des éléments : supprimés LOGIQUEMENT (§ 42), objets conservés. */
async function retirerPhotos(whereItems, t) {
  const photos = await InspectionPhoto.findAll({ where: whereItems, attributes: ['id', 'document_id'], transaction: t });
  if (photos.length) {
    await Document.destroy({ where: { id: photos.map((p) => p.document_id) }, transaction: t });
  }
  return photos.length;
}

// ── Propriétaire : lecture ─────────────────────────────────────────────────

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const c of ['lease_id', 'apartment_id', 'tenant_id', 'type', 'status']) if (f[c]) where[c] = f[c];
  return Inspection.findAndCountAll({ where, include: INCLUDE_LISTE, order: ordre(f.tri, '-created_at'), limit, offset });
}

async function detail(id, ownerId) {
  const inspection = await chargerPourProprietaire(Inspection, id, ownerId, { include: INCLUDE_ENTETE }, LIBELLE);
  return vueComplete(inspection);
}

// ── Propriétaire : création et saisie ──────────────────────────────────────

/**
 * Crée l'état des lieux depuis le bail avec la trame de pièces de
 * l'appartement (§ 52.3 étape 1), dans une seule transaction.
 */
async function creer(ownerId, user, donnees) {
  const inspectionId = await sequelize.transaction(async (t) => {
    const lease = await verifierReference(Lease, donnees.lease_id, ownerId, 'Bail', { transaction: t, lock: t.LOCK.UPDATE });
    if (!STATUTS_BAIL[donnees.type].includes(lease.status)) {
      throw new ConflictError(
        `Un état des lieux ${donnees.type === 'entree' ? "d'entrée" : 'de sortie'} ne peut pas être établi pour un bail « ${lease.status} ».`,
        'BAIL_STATUT_INCOMPATIBLE',
        { statut_bail: lease.status, statuts_admis: STATUTS_BAIL[donnees.type] }
      );
    }
    // Synchronisation différée (§ 52.4) : un renvoi de la même saisie hors
    // ligne retrouve l'état des lieux déjà créé au lieu d'échouer.
    if (donnees.client_reference) {
      const deja = await Inspection.findOne({ where: { owner_id: ownerId, client_reference: donnees.client_reference }, attributes: ['id'], transaction: t });
      if (deja) return deja.id;
    }
    const existant = await Inspection.findOne({
      where: { lease_id: lease.id, type: donnees.type, status: { [Op.ne]: 'remplace' } }, attributes: ['id', 'status'], transaction: t,
    });
    if (existant) {
      throw new ConflictError(
        `Un état des lieux ${TYPE_ETAT_DES_LIEUX[donnees.type].toLowerCase()} existe déjà pour ce bail : corrigez-le plutôt que d'en créer un autre.`,
        'ETAT_DES_LIEUX_EXISTANT',
        { inspection_id: existant.id, statut: existant.status }
      );
    }
    const apartment = await Apartment.findByPk(lease.apartment_id, { attributes: ['id', 'type', 'rooms_count', 'is_furnished'], paranoid: false, transaction: t });

    let inspection;
    try {
      inspection = await Inspection.create({
        owner_id: ownerId,
        lease_id: lease.id,
        apartment_id: lease.apartment_id,
        tenant_id: lease.tenant_id,
        type: donnees.type,
        version: 1,
        status: 'brouillon',
        performed_at: donnees.performed_at || null,
        parties_present: donnees.parties_present || [],
        client_reference: donnees.client_reference || null,
        created_by: user.id,
      }, { transaction: t });
    } catch (err) {
      // Course entre deux créations simultanées : l'index unique partiel arbitre.
      if (err instanceof UniqueConstraintError) throw new ConflictError('Un état des lieux de ce type existe déjà pour ce bail.', 'ETAT_DES_LIEUX_EXISTANT');
      throw err;
    }

    const trame = trameDesPieces(apartment.type, apartment.rooms_count, apartment.is_furnished);
    await insererPieces(inspection.id, trame, t);
    await journaliser({
      action: 'etat_des_lieux.creation', entityType: 'inspection', entityId: inspection.id, ownerId,
      details: {
        lease_id: lease.id, type: donnees.type, version: 1, pieces: trame.length,
        elements: trame.reduce((n, r) => n + r.items.length, 0), client_reference: donnees.client_reference || null,
      },
    }, t);
    return inspection.id;
  });
  return detail(inspectionId, ownerId);
}

/**
 * Insère des pièces et leurs éléments en DEUX requêtes (identifiants générés
 * ici pour relier les éléments à leur pièce sans relire la base).
 */
async function insererPieces(inspectionId, pieces, t) {
  const rooms = [];
  const items = [];
  for (const p of pieces) {
    const roomId = crypto.randomUUID();
    rooms.push({ id: roomId, inspection_id: inspectionId, name: p.name, position: p.position, notes: p.notes ?? null });
    (p.items || []).forEach((it, i) => items.push({
      id: it.id || crypto.randomUUID(),
      inspection_id: inspectionId,
      room_id: roomId,
      element: it.element,
      label: it.label ?? null,
      condition: it.condition || 'bon',
      comment: it.comment ?? null,
      position: it.position ?? i,
    }));
  }
  if (rooms.length) await InspectionRoom.bulkCreate(rooms, { transaction: t });
  if (items.length) await InspectionItem.bulkCreate(items, { transaction: t });
  return { rooms, items };
}

async function modifier(id, ownerId, donnees) {
  await sequelize.transaction(async (t) => {
    const inspection = await chargerModifiable(id, ownerId, t);
    const avant = inspection.toJSON();
    await inspection.update(donnees, { transaction: t, fields: CHAMPS_ENTETE });
    await journaliser({ action: 'etat_des_lieux.modification', entityType: 'inspection', entityId: id, ownerId, details: difference(avant, donnees, CHAMPS_ENTETE) }, t);
  });
  return detail(id, ownerId);
}

async function ajouterPiece(id, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const inspection = await chargerModifiable(id, ownerId, t);
    let position = donnees.position;
    if (position === undefined) {
      const max = await InspectionRoom.max('position', { where: { inspection_id: id }, transaction: t });
      position = Number.isInteger(max) ? max + 1 : 0;
    }
    let meuble = false;
    if (!donnees.items) {
      const apt = await Apartment.findByPk(inspection.apartment_id, { attributes: ['is_furnished'], paranoid: false, transaction: t });
      meuble = Boolean(apt?.is_furnished);
    }
    // Sans liste explicite, la pièce reçoit les éléments proposés pour sa nature.
    const items = donnees.items || elementsParDefaut(donnees.name, meuble);
    const { rooms } = await insererPieces(id, [{ name: donnees.name, notes: donnees.notes, position, items }], t);
    await journaliser({
      action: 'etat_des_lieux.modification', entityType: 'inspection', entityId: id, ownerId,
      details: { ajout_piece: { room_id: rooms[0].id, name: donnees.name, elements: items.length } },
    }, t);
    const [room] = await chargerArbreDePiece(rooms[0].id, t);
    return room;
  });
}

async function chargerArbreDePiece(roomId, t) {
  const room = await InspectionRoom.findByPk(roomId, {
    include: [{ model: InspectionItem, as: 'items', required: false }],
    order: [[{ model: InspectionItem, as: 'items' }, 'position', 'ASC']],
    transaction: t,
  });
  return [{ ...room.toJSON(), items: (room.items || []).map((i) => ({ ...i.toJSON(), photos: [] })) }];
}

async function modifierPiece(id, roomId, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    await chargerModifiable(id, ownerId, t);
    const room = await chargerPiece(id, roomId, t);
    const champs = ['name', 'notes', 'position'];
    const avant = room.toJSON();
    await room.update(donnees, { transaction: t, fields: champs });
    await journaliser({ action: 'etat_des_lieux.modification', entityType: 'inspection', entityId: id, ownerId, details: { piece: roomId, ...difference(avant, donnees, champs) } }, t);
    return room;
  });
}

async function supprimerPiece(id, roomId, ownerId) {
  return sequelize.transaction(async (t) => {
    await chargerModifiable(id, ownerId, t);
    const room = await chargerPiece(id, roomId, t);
    const items = await InspectionItem.findAll({ where: { room_id: roomId }, attributes: ['id'], transaction: t });
    const photos = items.length ? await retirerPhotos({ item_id: items.map((i) => i.id) }, t) : 0;
    // Éléments et lignes de photos supprimés en cascade (clés étrangères ON DELETE CASCADE).
    await room.destroy({ transaction: t });
    await journaliser({ action: 'etat_des_lieux.modification', entityType: 'inspection', entityId: id, ownerId, details: { suppression_piece: { room_id: roomId, name: room.name, photos_retirees: photos } } }, t);
  });
}

async function ajouterElement(id, roomId, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    await chargerModifiable(id, ownerId, t);
    await chargerPiece(id, roomId, t);
    const max = await InspectionItem.max('position', { where: { room_id: roomId }, transaction: t });
    const item = await InspectionItem.create({
      inspection_id: id, room_id: roomId, element: donnees.element, label: donnees.label ?? null,
      condition: donnees.condition || 'bon', comment: donnees.comment ?? null,
      position: donnees.position ?? (Number.isInteger(max) ? max + 1 : 0),
    }, { transaction: t });
    await journaliser({ action: 'etat_des_lieux.modification', entityType: 'inspection', entityId: id, ownerId, details: { ajout_element: { item_id: item.id, room_id: roomId, element: item.element, label: item.label } } }, t);
    return { ...item.toJSON(), photos: [] };
  });
}

async function modifierElement(id, itemId, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    await chargerModifiable(id, ownerId, t);
    const item = await chargerElement(id, itemId, t);
    const champs = ['condition', 'comment', 'label', 'position'];
    const avant = item.toJSON();
    await item.update(donnees, { transaction: t, fields: champs });
    await journaliser({ action: 'etat_des_lieux.modification', entityType: 'inspection', entityId: id, ownerId, details: { element: itemId, ...difference(avant, donnees, champs) } }, t);
    return item;
  });
}

async function supprimerElement(id, itemId, ownerId) {
  return sequelize.transaction(async (t) => {
    await chargerModifiable(id, ownerId, t);
    const item = await chargerElement(id, itemId, t);
    const photos = await retirerPhotos({ item_id: itemId }, t);
    await item.destroy({ transaction: t });
    await journaliser({ action: 'etat_des_lieux.modification', entityType: 'inspection', entityId: id, ownerId, details: { suppression_element: { item_id: itemId, element: item.element, label: item.label, photos_retirees: photos } } }, t);
  });
}

/**
 * Saisie groupée (§ 52.4 « saisie possible hors ligne, avec synchronisation
 * différée ») : tous les éléments relevés sans réseau arrivent en UNE requête
 * et sont appliqués en UNE instruction SQL (UPDATE … FROM VALUES), après
 * vérification que CHAQUE élément appartient bien à cet état des lieux.
 * Un commentaire absent du lot est laissé tel quel ; `null` ou '' l'efface.
 */
async function saisie(id, ownerId, { items }) {
  await sequelize.transaction(async (t) => {
    await chargerModifiable(id, ownerId, t);
    const ids = items.map((i) => i.item_id);
    const existants = await InspectionItem.findAll({ where: { id: ids, inspection_id: id }, attributes: ['id', 'condition', 'comment'], transaction: t });
    if (existants.length !== ids.length) {
      const connus = new Set(existants.map((e) => e.id));
      throw new ValidationError('Données invalides', ids.filter((i) => !connus.has(i)).map((i) => `L'élément ${i} n'appartient pas à cet état des lieux`), 'ELEMENT_ETRANGER');
    }

    const replacements = { inspectionId: id };
    const valeurs = items.map((it, i) => {
      replacements[`id${i}`] = it.item_id;
      replacements[`c${i}`] = it.condition;
      replacements[`m${i}`] = it.comment === undefined ? null : (it.comment || null);
      replacements[`s${i}`] = it.comment !== undefined;
      return `(CAST(:id${i} AS uuid), CAST(:c${i} AS varchar), CAST(:m${i} AS text), CAST(:s${i} AS boolean))`;
    }).join(', ');
    await sequelize.query(
      `UPDATE inspection_items AS i
          SET condition = v.condition,
              comment = CASE WHEN v.maj_commentaire THEN v.comment ELSE i.comment END
         FROM (VALUES ${valeurs}) AS v(id, condition, comment, maj_commentaire)
        WHERE i.id = v.id AND i.inspection_id = :inspectionId`,
      { replacements, type: QueryTypes.UPDATE, transaction: t }
    );

    const avant = new Map(existants.map((e) => [e.id, e]));
    const changements = items
      .filter((it) => avant.get(it.item_id).condition !== it.condition)
      .map((it) => ({ item_id: it.item_id, avant: avant.get(it.item_id).condition, apres: it.condition }));
    await journaliser({
      action: 'etat_des_lieux.modification', entityType: 'inspection', entityId: id, ownerId,
      details: { saisie_groupee: items.length, etats_modifies: changements.slice(0, 200) },
    }, t);
  });
  return detail(id, ownerId);
}

/**
 * Photo d'un élément (§ 52.2 « photos par élément », § 52.4 « horodatée par
 * le serveur ») : le document garde `captured_at` (prise de vue sur le
 * téléphone, conservée même après une synchronisation différée) et la ligne
 * de photo son `created_at` serveur.
 */
async function ajouterPhoto(id, itemId, ownerId, user, fichier, { captured_at: capturedAt }) {
  return transactionAvecFichiers(async (t) => {
    const inspection = await chargerModifiable(id, ownerId, t);
    const item = await chargerElement(id, itemId, t);
    const nb = await InspectionPhoto.count({ where: { item_id: itemId }, transaction: t });
    if (nb >= PHOTOS_MAX_PAR_ELEMENT) {
      throw new ConflictError(`${PHOTOS_MAX_PAR_ELEMENT} photos maximum par élément.`, 'PHOTOS_TROP_NOMBREUSES');
    }
    // Photo d'un BROUILLON : invisible du locataire tant que l'état des lieux
    // ne lui est pas présenté (§ 52.3 étape 3) — sinon GET /documents la lui
    // montrerait alors que le brouillon lui-même lui est caché. `soumettre`
    // la rend visible.
    const document = await documents.creerDocument({
      ownerId, tenantId: inspection.tenant_id, entityType: 'inspection', entityId: id, category: 'photo',
      fichier, visibleToTenant: false, capturedAt: capturedAt || null, uploadedBy: user.id,
    }, t);
    const photo = await InspectionPhoto.create({ inspection_id: id, item_id: item.id, document_id: document.id, captured_at: capturedAt || null }, { transaction: t });
    await journaliser({
      action: 'etat_des_lieux.ajout_document', entityType: 'inspection', entityId: id, ownerId,
      details: { document_id: document.id, item_id: item.id, element: item.element, captured_at: capturedAt || null },
    }, t);
    return { id: photo.id, item_id: item.id, captured_at: photo.captured_at, created_at: photo.created_at, document: documents.versApi(document) };
  });
}

async function supprimerPhoto(id, photoId, ownerId) {
  return sequelize.transaction(async (t) => {
    await chargerModifiable(id, ownerId, t);
    const photo = await InspectionPhoto.findOne({ where: { id: photoId, inspection_id: id }, transaction: t });
    if (!photo) throw new NotFoundError('Photo introuvable dans cet état des lieux');
    await photo.destroy({ transaction: t });
    // Suppression LOGIQUE du document : l'objet stocké peut être partagé avec une version antérieure.
    await Document.destroy({ where: { id: photo.document_id }, transaction: t });
    await journaliser({ action: 'etat_des_lieux.modification', entityType: 'inspection', entityId: id, ownerId, details: { suppression_photo: { photo_id: photoId, document_id: photo.document_id, item_id: photo.item_id } } }, t);
  });
}

// ── Propriétaire : cycle de vie ────────────────────────────────────────────

/**
 * Présentation au locataire (§ 52.3 étape 3) : délai de réponse pris dans les
 * paramètres du propriétaire (`inspection_response_days`).
 */
async function soumettre(id, ownerId) {
  await sequelize.transaction(async (t) => {
    const inspection = await chargerPourProprietaire(Inspection, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, LIBELLE);
    verifierTransition(ETAT_DES_LIEUX, inspection.status, 'soumis', "l'état des lieux");
    const nbElements = await InspectionItem.count({ where: { inspection_id: id }, transaction: t });
    if (!nbElements) {
      throw new ConflictError('Un état des lieux sans aucune pièce relevée ne peut pas être soumis.', 'ETAT_DES_LIEUX_VIDE');
    }
    const reglages = await parametres.proprietaire(ownerId, t);
    const maintenant = new Date();
    const echeance = new Date(maintenant.getTime() + reglages.inspection_response_days * 86_400_000);
    await inspection.update({
      status: 'soumis',
      submitted_at: maintenant,
      response_deadline: echeance,
      // La date de visite est obligatoire au contenu (§ 52.2) : à défaut, celle de la soumission.
      performed_at: inspection.performed_at || maintenant,
    }, { transaction: t });
    // Présenté au locataire : ses photos le sont aussi (masquées pendant le brouillon).
    const photos = await InspectionPhoto.findAll({ where: { inspection_id: id }, attributes: ['document_id'], transaction: t });
    if (photos.length) {
      await Document.update({ visible_to_tenant: true }, { where: { id: photos.map((p) => p.document_id) }, transaction: t });
    }
    await journaliser({
      action: 'etat_des_lieux.changement_statut', entityType: 'inspection', entityId: id, ownerId,
      details: { avant: 'brouillon', apres: 'soumis', delai_jours: reglages.inspection_response_days, echeance },
    }, t);
    const tenant = await Tenant.findByPk(inspection.tenant_id, { attributes: ['id', 'user_id'], paranoid: false, transaction: t });
    await notifier(t, {
      destinataires: [destinataireLocataire(tenant)], ownerId, type: 'etat_des_lieux',
      titre: `État des lieux ${inspection.type === 'entree' ? "d'entrée" : 'de sortie'} à valider`,
      corps: `Consultez l'état des lieux dans votre espace et acceptez-le ou contestez-le avant le ${dateHeure(echeance)}. Sans réponse, il sera considéré comme accepté.`,
      donnees: { inspection_id: id, lease_id: inspection.lease_id },
    });
  });
  return detail(id, ownerId);
}

/**
 * Correction (§ 52.4, § 56.1 « toute correction crée une nouvelle version
 * tracée dans le journal d'audit ») : l'ancienne version passe à « remplace »
 * et une copie en brouillon (version + 1) reprend pièces, éléments, états,
 * commentaires et photos.
 *
 * Photos : `inspection_photos.document_id` est UNIQUE, une photo ne peut donc
 * pas appartenir à deux versions. Chaque photo reçoit une NOUVELLE ligne
 * `documents` qui réutilise la même clé de stockage (non unique) : aucun
 * octet recopié, et l'ancienne version garde ses photos intactes. C'est sans
 * risque car les documents ne sont supprimés que LOGIQUEMENT (l'objet stocké
 * n'est jamais effacé tant qu'une ligne y fait référence) ; c'est aussi
 * pourquoi cette transaction n'utilise pas `transactionAvecFichiers`, qui
 * effacerait l'objet partagé en cas d'échec.
 */
async function corriger(id, ownerId, user) {
  const nouvelId = await sequelize.transaction(async (t) => {
    const ancienne = await chargerPourProprietaire(Inspection, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, LIBELLE);
    if (!['conteste', 'accepte'].includes(ancienne.status)) {
      throw new ConflictError(
        ancienne.status === 'brouillon'
          ? 'Ce brouillon est encore modifiable : corrigez-le directement.'
          : `Un état des lieux « ${ancienne.status} » ne peut pas être corrigé : seuls les états contestés ou acceptés le sont.`,
        'TRANSITION_INVALIDE',
        { statutActuel: ancienne.status }
      );
    }
    verifierTransition(ETAT_DES_LIEUX, ancienne.status, 'remplace', "l'état des lieux");
    const rooms = await chargerArbre(id, t);
    const statutAvant = ancienne.status;

    // D'abord « remplace » : libère l'index unique partiel pour la nouvelle version.
    await ancienne.update({ status: 'remplace' }, { transaction: t });
    const nouvelle = await Inspection.create({
      owner_id: ownerId,
      lease_id: ancienne.lease_id,
      apartment_id: ancienne.apartment_id,
      tenant_id: ancienne.tenant_id,
      type: ancienne.type,
      version: ancienne.version + 1,
      previous_version_id: ancienne.id,
      status: 'brouillon',
      performed_at: ancienne.performed_at,
      parties_present: ancienne.parties_present,
      water_meter: ancienne.water_meter,
      electricity_meter: ancienne.electricity_meter,
      keys_count: ancienne.keys_count,
      keys_details: ancienne.keys_details,
      general_observations: ancienne.general_observations,
      created_by: user.id,
    }, { transaction: t });

    const pieces = rooms.map((r) => ({
      name: r.name, notes: r.notes, position: r.position,
      items: r.items.map((i) => ({ ...i, id: crypto.randomUUID() })),
    }));
    await insererPieces(nouvelle.id, pieces, t);

    const nouveauxDocs = [];
    const nouvellesPhotos = [];
    for (const p of pieces) {
      for (const it of p.items) {
        for (const ph of it.photos) {
          const d = ph.document;
          const docId = crypto.randomUUID();
          nouveauxDocs.push({
            id: docId, owner_id: d.owner_id, tenant_id: d.tenant_id, entity_type: 'inspection', entity_id: nouvelle.id,
            category: d.category, storage_key: d.storage_key, thumbnail_key: d.thumbnail_key, mime_type: d.mime_type,
            size_bytes: d.size_bytes, original_name: d.original_name, checksum: d.checksum,
            // La nouvelle version est un brouillon : ses photos restent cachées au locataire jusqu'à sa soumission.
            visible_to_tenant: false, captured_at: d.captured_at, uploaded_by: d.uploaded_by,
          });
          nouvellesPhotos.push({ inspection_id: nouvelle.id, item_id: it.id, document_id: docId, captured_at: ph.captured_at });
        }
      }
    }
    if (nouveauxDocs.length) {
      await Document.bulkCreate(nouveauxDocs, { transaction: t });
      await InspectionPhoto.bulkCreate(nouvellesPhotos, { transaction: t });
    }

    await journaliser({
      action: 'etat_des_lieux.changement_statut', entityType: 'inspection', entityId: ancienne.id, ownerId,
      details: { avant: statutAvant, apres: 'remplace', nouvelle_version_id: nouvelle.id },
    }, t);
    await journaliser({
      action: 'etat_des_lieux.nouvelle_version', entityType: 'inspection', entityId: nouvelle.id, ownerId,
      details: {
        version: nouvelle.version, previous_version_id: ancienne.id, statut_precedent: statutAvant,
        pieces: pieces.length, photos_reprises: nouvellesPhotos.length,
      },
    }, t);
    return nouvelle.id;
  });
  return detail(nouvelId, ownerId);
}

/** Suppression : seulement un premier brouillon (aucun historique à préserver). */
async function supprimer(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const inspection = await chargerModifiable(id, ownerId, t);
    if (inspection.version !== 1 || inspection.previous_version_id) {
      throw new ConflictError('Une version corrigée ne se supprime pas : elle fait partie de l’historique de l’état des lieux.', 'ETAT_DES_LIEUX_HISTORISE');
    }
    await Document.destroy({ where: { entity_type: 'inspection', entity_id: id }, transaction: t });
    // Pièces, éléments et lignes de photos supprimés en cascade.
    await inspection.destroy({ transaction: t });
    await journaliser({ action: 'etat_des_lieux.suppression', entityType: 'inspection', entityId: id, ownerId, details: { lease_id: inspection.lease_id, type: inspection.type } }, t);
  });
}

// ── Comparaison entrée / sortie ────────────────────────────────────────────

/** § 52.3 étape 5 — dernières versions vivantes d'entrée et de sortie du bail. */
async function comparaison(ownerId, leaseId) {
  const lease = await chargerPourProprietaire(Lease, leaseId, ownerId, { attributes: ['id', 'owner_id', 'reference'] }, 'Bail');
  const edls = await Inspection.findAll({
    where: { lease_id: lease.id, status: { [Op.ne]: 'remplace' } },
    attributes: ['id', 'type', 'version', 'status', 'performed_at'],
  });
  const entree = edls.find((e) => e.type === 'entree');
  const sortie = edls.find((e) => e.type === 'sortie');
  if (!entree || !sortie) {
    throw new ConflictError(
      `La comparaison exige un état des lieux d'entrée et un de sortie (manquant : ${!entree ? 'entrée' : 'sortie'}).`,
      'ETAT_DES_LIEUX_MANQUANT'
    );
  }
  const [piecesEntree, piecesSortie] = await Promise.all([chargerArbre(entree.id), chargerArbre(sortie.id)]);
  const resultat = comparerEtatsDesLieux({ rooms: arbreVersApi(piecesEntree) }, { rooms: arbreVersApi(piecesSortie) });
  return { lease: { id: lease.id, reference: lease.reference }, entree, sortie, ...resultat };
}

// ── PDF et acceptation ─────────────────────────────────────────────────────

async function genererPourInspection(inspectionId, transaction) {
  const inspection = await Inspection.findByPk(inspectionId, { include: INCLUDE_ENTETE, transaction });
  const [rooms, owner] = await Promise.all([
    chargerArbre(inspectionId, transaction),
    Owner.findByPk(inspection.owner_id, { attributes: ['id', 'display_name', 'company_name', 'phone'], paranoid: false, transaction }),
  ]);
  return { inspection, contenu: await genererPdf(inspection.toJSON(), rooms, owner) };
}

function nomPdf(inspection) {
  return `etat-des-lieux-${inspection.type}-v${inspection.version}.pdf`;
}

/**
 * PDF : l'exemplaire ARCHIVÉ s'il existe (accepté, § 52.3 étape 4) — jamais
 * régénéré, c'est la pièce probante —, sinon généré à la volée (brouillon
 * avec filigrane).
 * @returns {Promise<{ flux?: NodeJS.ReadableStream, taille?: number, contenu?: Buffer, nom: string }>}
 */
async function fichierPdf(inspection) {
  if (inspection.document_id) {
    const doc = await Document.findByPk(inspection.document_id);
    const objet = doc ? await storage.ouvrir(doc.storage_key) : null;
    if (objet) return { flux: objet.stream, taille: objet.taille, nom: nomPdf(inspection) };
    logger.warn('[etat_des_lieux] PDF archivé introuvable dans le stockage, génération à la volée', { inspection_id: inspection.id });
  }
  const { contenu } = await genererPourInspection(inspection.id);
  return { contenu, nom: nomPdf(inspection) };
}

async function pdfProprietaire(id, ownerId) {
  const inspection = await chargerPourProprietaire(Inspection, id, ownerId, {}, LIBELLE);
  return fichierPdf(inspection);
}

/**
 * Acceptation (explicite ou tacite) : verrouillage + PDF archivé dans la même
 * transaction (§ 52.3 étape 4). L'inspection est déjà verrouillée (FOR UPDATE).
 */
async function accepterDansTransaction(inspection, { tacite, userId }, t) {
  const maintenant = new Date();
  await inspection.update({ status: 'accepte', accepted_at: maintenant, accepted_tacitly: tacite, locked_at: maintenant }, { transaction: t });
  const { contenu } = await genererPourInspection(inspection.id, t);
  const document = await documents.creerDocument({
    ownerId: inspection.owner_id, tenantId: inspection.tenant_id, entityType: 'inspection', entityId: inspection.id,
    category: 'etat_des_lieux',
    fichier: { buffer: contenu, type: 'pdf', mime: 'application/pdf', nomOrigine: nomPdf(inspection) },
    visibleToTenant: true, uploadedBy: userId || null,
  }, t);
  await inspection.update({ document_id: document.id }, { transaction: t });
  return document;
}

// ── Locataire (§ 52.3 étape 3) ─────────────────────────────────────────────

async function chargerLocataire(id, tenantIds, options = {}) {
  const inspection = await chargerPourLocataire(Inspection, id, tenantIds, options, LIBELLE);
  // Le brouillon est encore en préparation : il n'existe pas pour le locataire.
  if (inspection.status === 'brouillon') throw new NotFoundError(`${LIBELLE} introuvable`);
  return inspection;
}

async function listerLocataire(tenantIds, f, { limit, offset }) {
  const where = { tenant_id: { [Op.in]: tenantIds }, status: { [Op.in]: STATUTS_LOCATAIRE } };
  // `status` est restreint par Joi aux statuts visibles du locataire.
  for (const c of ['lease_id', 'type', 'status']) if (f[c]) where[c] = f[c];
  return Inspection.findAndCountAll({
    where,
    include: INCLUDE_LISTE,
    attributes: { exclude: ['created_by'] },
    order: ordre(f.tri, '-created_at'),
    limit,
    offset,
  });
}

async function detailLocataire(id, tenantIds) {
  const inspection = await chargerLocataire(id, tenantIds, { include: INCLUDE_ENTETE });
  return vueComplete(inspection, { locataire: true });
}

async function pdfLocataire(id, tenantIds) {
  const inspection = await chargerLocataire(id, tenantIds);
  return fichierPdf(inspection);
}

function exigerDansLeDelai(inspection, maintenant = new Date()) {
  if (inspection.response_deadline && new Date(inspection.response_deadline) < maintenant) {
    throw new ConflictError(
      `Le délai de réponse a expiré le ${dateHeure(inspection.response_deadline)} : l'état des lieux est réputé accepté.`,
      'DELAI_DEPASSE'
    );
  }
}

async function accepter(id, tenantIds, user) {
  await transactionAvecFichiers(async (t) => {
    const inspection = await chargerLocataire(id, tenantIds, { transaction: t, lock: t.LOCK.UPDATE });
    verifierTransition(ETAT_DES_LIEUX, inspection.status, 'accepte', "l'état des lieux");
    exigerDansLeDelai(inspection);
    const document = await accepterDansTransaction(inspection, { tacite: false, userId: user.id }, t);
    await journaliser({
      action: 'etat_des_lieux.changement_statut', entityType: 'inspection', entityId: id, ownerId: inspection.owner_id,
      details: { avant: 'soumis', apres: 'accepte', tacite: false, document_id: document.id },
    }, t);
    await notifier(t, {
      destinataires: await destinatairesProprietaire(inspection.owner_id, t), ownerId: inspection.owner_id, type: 'etat_des_lieux',
      titre: 'État des lieux accepté',
      corps: `Le locataire a accepté l'état des lieux ${inspection.type === 'entree' ? "d'entrée" : 'de sortie'} : il est verrouillé et archivé en PDF.`,
      donnees: { inspection_id: id, lease_id: inspection.lease_id, document_id: document.id },
    });
  });
  return detailLocataire(id, tenantIds);
}

async function contester(id, tenantIds, user, commentaire) {
  await sequelize.transaction(async (t) => {
    const inspection = await chargerLocataire(id, tenantIds, { transaction: t, lock: t.LOCK.UPDATE });
    verifierTransition(ETAT_DES_LIEUX, inspection.status, 'conteste', "l'état des lieux");
    exigerDansLeDelai(inspection);
    await inspection.update({ status: 'conteste', contested_at: new Date(), contest_comment: commentaire }, { transaction: t });
    await journaliser({
      action: 'etat_des_lieux.changement_statut', entityType: 'inspection', entityId: id, ownerId: inspection.owner_id,
      details: { avant: 'soumis', apres: 'conteste', commentaire },
    }, t);
    await notifier(t, {
      destinataires: await destinatairesProprietaire(inspection.owner_id, t), ownerId: inspection.owner_id, type: 'etat_des_lieux',
      titre: 'État des lieux contesté',
      corps: `Le locataire conteste l'état des lieux ${inspection.type === 'entree' ? "d'entrée" : 'de sortie'} : « ${commentaire.slice(0, 200)} ». Corrigez-le pour lui soumettre une nouvelle version.`,
      donnees: { inspection_id: id, lease_id: inspection.lease_id },
    });
  });
  return detailLocataire(id, tenantIds);
}

// ── Tâche planifiée : acceptation tacite ───────────────────────────────────

/**
 * Acceptation tacite à l'échéance du délai configurable (§ 52.3 étape 3) :
 * tout état des lieux « soumis » dont `response_deadline` est dépassée devient
 * « accepte » (`accepted_tacitly`), verrouillé et archivé en PDF.
 *
 * - Sélection par LOTS avec curseur (response_deadline, id) sur l'index
 *   partiel `inspections_echeance_idx` : une requête par lot, jamais par ligne,
 *   et un état des lieux en échec n'est pas resélectionné indéfiniment.
 * - UNE transaction par état des lieux, avec verrou et re-vérification : une
 *   acceptation ou contestation du locataire arrivée entre-temps l'emporte, et
 *   l'échec de l'un n'annule pas les autres.
 * - Journal d'audit sans acteur : attribué au « systeme ».
 *
 * @param {Date} [maintenant]
 * @returns {Promise<{ acceptes: number, echecs: number }>}
 */
async function accepterTacitement(maintenant = new Date()) {
  let acceptes = 0;
  let echecs = 0;
  let curseur = null;
  for (;;) {
    const where = { status: 'soumis', response_deadline: { [Op.lt]: maintenant } };
    if (curseur) {
      where[Op.or] = [
        { response_deadline: { [Op.gt]: curseur.response_deadline } },
        { response_deadline: curseur.response_deadline, id: { [Op.gt]: curseur.id } },
      ];
    }
    const lot = await Inspection.findAll({
      where, attributes: ['id', 'response_deadline'], order: [['response_deadline', 'ASC'], ['id', 'ASC']], limit: LOT_TACITE,
    });
    for (const { id } of lot) {
      try {
        if (await accepterTacitementUn(id, maintenant)) acceptes += 1;
      } catch (err) {
        echecs += 1;
        logger.error('[etat_des_lieux] Acceptation tacite impossible', { inspection_id: id, error: err.message });
      }
    }
    if (lot.length < LOT_TACITE) break;
    curseur = lot[lot.length - 1];
  }
  return { acceptes, echecs };
}

async function accepterTacitementUn(id, maintenant) {
  return transactionAvecFichiers(async (t) => {
    const inspection = await Inspection.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!inspection || inspection.status !== 'soumis' || !(new Date(inspection.response_deadline) < maintenant)) return false;
    const document = await accepterDansTransaction(inspection, { tacite: true, userId: null }, t);
    await journaliser({
      action: 'etat_des_lieux.changement_statut', entityType: 'inspection', entityId: id, ownerId: inspection.owner_id,
      // Aucun acteur ni contexte de requête : l'audit l'attribue au « systeme ».
      details: { avant: 'soumis', apres: 'accepte', tacite: true, echeance: inspection.response_deadline, document_id: document.id },
    }, t);
    const tenant = await Tenant.findByPk(inspection.tenant_id, { attributes: ['id', 'user_id'], paranoid: false, transaction: t });
    const quoi = `L'état des lieux ${inspection.type === 'entree' ? "d'entrée" : 'de sortie'}`;
    await notifier(t, {
      destinataires: [...(await destinatairesProprietaire(inspection.owner_id, t)), destinataireLocataire(tenant)],
      ownerId: inspection.owner_id, type: 'etat_des_lieux',
      titre: 'État des lieux accepté tacitement',
      corps: `${quoi} n'a pas reçu de réponse dans le délai : il est réputé accepté, verrouillé et archivé en PDF.`,
      donnees: { inspection_id: id, lease_id: inspection.lease_id, document_id: document.id },
    });
    return true;
  });
}

module.exports = {
  lister, detail, creer, modifier, ajouterPiece, modifierPiece, supprimerPiece,
  ajouterElement, modifierElement, supprimerElement, saisie, ajouterPhoto, supprimerPhoto,
  soumettre, corriger, supprimer, comparaison, pdfProprietaire,
  listerLocataire, detailLocataire, pdfLocataire, accepter, contester,
  accepterTacitement,
};
