'use strict';

const { UniqueConstraintError } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Expense, ExpenseCategory, Building, Apartment, Contractor, WorkOrder, CashMovement,
} = require('../../../models/index.js');
const { chargerPourProprietaire, verifierReference } = require('../../../utils/acces.js');
const { ordre, periode } = require('../../../utils/liste.js');
const { pad } = require('../../../utils/compteur.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { ConflictError, ValidationError } = require('../../../errors/AppError.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const caisse = require('../../caisse/service/caisse.service.js');
const documents = require('../../document/service/document.service.js');
const categories = require('./categorie.service.js');
const { notifier, destinatairesProprietaire } = require('../../notification/service/notification.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Dépenses (§ 20) et leur reflet en caisse (§ 21).
 *
 * Règles du § 41 :
 *   - « une dépense doit être liée à un immeuble et éventuellement à un
 *     appartement » : building_id obligatoire, appartement de CE bâtiment ;
 *   - « une dépense en espèces doit être enregistrée dans la caisse » : TOUTE
 *     dépense crée sa sortie de caisse dans la MÊME transaction (le journal de
 *     caisse est la trésorerie complète, quel que soit le mode) ;
 *   - « une suppression financière importante doit être logique » (§ 42) : une
 *     dépense n'est jamais supprimée, elle est ANNULÉE avec son mouvement.
 *
 * Intégrité financière : le MONTANT, le mode et la date d'une dépense ne se
 * modifient pas. Ils ont produit un mouvement de caisse déjà lu dans des
 * synthèses et rapports ; une correction = annulation (tracée, motivée) puis
 * nouvelle saisie. Seuls les champs descriptifs restent modifiables.
 *
 * Hors ligne (§ 34) : `client_reference` (unique par propriétaire) rend la
 * synchronisation différée idempotente — un renvoi retourne la dépense déjà
 * créée au lieu d'en créer une seconde.
 */

/** Groupe de sorties (catégorie de dépense) → catégorie de mouvement de caisse (§ 21). */
const GROUPE_VERS_CAISSE = Object.freeze({
  travaux: 'travaux',
  entretien: 'entretien',
  factures: 'factures',
  nettoyage: 'nettoyage',
  securite: 'securite',
  autre: 'autre_depense',
});

const CHAMPS_MODIFIABLES = ['description', 'category_id', 'contractor_id', 'apartment_id'];

const INCLUDE_LISTE = [
  { model: ExpenseCategory, as: 'category', attributes: ['id', 'code', 'name', 'cash_group'] },
  { model: Building, as: 'building', attributes: ['id', 'name'], paranoid: false },
  { model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false },
  { model: Contractor, as: 'contractor', attributes: ['id', 'name', 'trade'], paranoid: false },
  { model: WorkOrder, as: 'workOrder', attributes: ['id', 'number', 'title', 'status'] },
];

const libelleCaisse = (categorie, description) => (description ? `${categorie.name} — ${description}` : categorie.name);

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['building_id', 'apartment_id', 'category_id', 'method', 'work_order_id', 'contractor_id', 'status']) {
    if (f[cle]) where[cle] = f[cle];
  }
  const p = periode(f.du, f.au);
  if (p) where.spent_on = p;
  // Toutes les jointures sont des belongsTo : une seule requête, pas de N+1.
  return Expense.findAndCountAll({ where, include: INCLUDE_LISTE, order: ordre(f.tri, '-spent_on'), limit, offset });
}

async function detail(id, ownerId) {
  const expense = await chargerPropre(id, ownerId);
  const pieces = await documents.listerPourEntite('expense', id);
  return { ...expense.toJSON(), documents: pieces.map(documents.versApi) };
}

function chargerPropre(id, ownerId, options = {}) {
  return chargerPourProprietaire(Expense, id, ownerId, { include: INCLUDE_LISTE, ...options }, 'Dépense');
}

/**
 * Vérifie chaque rattachement (propriétaire ET cohérence) :
 * appartement de l'immeuble, travaux de l'immeuble et non annulés.
 */
async function verifierRattachements(t, ownerId, d) {
  const building = await verifierReference(Building, d.building_id, ownerId, 'Immeuble', { transaction: t });
  if (d.apartment_id) {
    const apartment = await verifierReference(Apartment, d.apartment_id, ownerId, 'Appartement', { transaction: t });
    if (apartment.building_id !== building.id) {
      throw new ValidationError('Données invalides', ["L'appartement n'appartient pas à l'immeuble de la dépense"]);
    }
  }
  if (d.contractor_id) await verifierReference(Contractor, d.contractor_id, ownerId, 'Artisan', { transaction: t });
  if (d.work_order_id) {
    const wo = await verifierReference(WorkOrder, d.work_order_id, ownerId, 'Travaux', { transaction: t });
    if (wo.building_id !== building.id) throw new ValidationError('Données invalides', ["Les travaux ne concernent pas l'immeuble de la dépense"]);
    if (wo.status === 'annule') throw new ConflictError('Impossible de rattacher une dépense à des travaux annulés.', 'TRAVAUX_ANNULES');
  }
  return building;
}

/**
 * Création dans une transaction ouverte par l'appelant : dépense + sortie de
 * caisse + audit + notification, tout ou rien.
 */
async function creerDansTransaction(t, ownerId, user, d) {
  const categorie = await categories.resoudre(d.category_id, ownerId, t);
  await verifierRattachements(t, ownerId, d);

  const expense = await Expense.create({
    owner_id: ownerId,
    building_id: d.building_id,
    apartment_id: d.apartment_id || null,
    category_id: categorie.id,
    amount: d.amount,
    method: d.method,
    spent_on: d.spent_on,
    description: d.description || null,
    contractor_id: d.contractor_id || null,
    work_order_id: d.work_order_id || null,
    client_reference: d.client_reference || null,
    status: 'valide',
    created_by: user.id,
  }, { transaction: t });

  await caisse.enregistrerMouvement(t, {
    ownerId,
    buildingId: expense.building_id,
    apartmentId: expense.apartment_id,
    direction: 'sortie',
    category: GROUPE_VERS_CAISSE[categorie.cash_group],
    amount: expense.amount,
    method: expense.method,
    occurredOn: expense.spent_on,
    label: libelleCaisse(categorie, expense.description),
    sourceType: 'expense',
    sourceId: expense.id,
    createdBy: user.id,
  });

  // § 40 — « Création dépense, montant, appartement ».
  await journaliser({
    action: 'depense.creation', entityType: 'expense', entityId: expense.id, ownerId,
    details: {
      montant: expense.amount, categorie: categorie.code, mode: expense.method, date: expense.spent_on,
      building_id: expense.building_id, apartment_id: expense.apartment_id, work_order_id: expense.work_order_id,
    },
  }, t);

  // § 27 « Dépense » : les AUTRES membres de l'espace (l'auteur sait ce qu'il vient de saisir).
  const destinataires = (await destinatairesProprietaire(ownerId, t)).filter((d2) => d2.userId !== user.id);
  if (destinataires.length) {
    await notifier(t, {
      destinataires, ownerId, type: 'depense',
      titre: 'Nouvelle dépense enregistrée',
      corps: `${formatFcfa(expense.amount)} — ${categorie.name}${expense.description ? ` : ${expense.description}` : ''}`,
      donnees: { expense_id: expense.id, building_id: expense.building_id },
    });
  }
  return expense;
}

const parReferenceClient = (ownerId, reference) => (reference
  ? Expense.findOne({ where: { owner_id: ownerId, client_reference: reference } })
  : null);

/**
 * Enveloppe de création idempotente par `client_reference`.
 * Deux synchronisations concurrentes de la même opération hors ligne : l'index
 * unique arbitre, la perdante relit et renvoie la dépense de la gagnante.
 *
 * @returns {Promise<{ expense: object, rejoue: boolean }>}
 */
async function creerIdempotent(ownerId, reference, creation) {
  const existante = await parReferenceClient(ownerId, reference);
  if (existante) return { expense: await chargerPropre(existante.id, ownerId), rejoue: true };
  try {
    const expense = await sequelize.transaction(creation);
    return { expense: await chargerPropre(expense.id, ownerId), rejoue: false };
  } catch (err) {
    if (err instanceof UniqueConstraintError && reference) {
      const gagnante = await parReferenceClient(ownerId, reference);
      if (gagnante) return { expense: await chargerPropre(gagnante.id, ownerId), rejoue: true };
    }
    throw err;
  }
}

async function creer(ownerId, user, donnees) {
  return creerIdempotent(ownerId, donnees.client_reference, (t) => creerDansTransaction(t, ownerId, user, donnees));
}

/**
 * § 23 étape 7 « Enregistrement de la dépense » d'un chantier : immeuble,
 * appartement et artisan viennent des travaux ; catégorie « travaux » par
 * défaut.
 */
async function creerPourTravaux(workOrderId, ownerId, user, donnees) {
  return creerIdempotent(ownerId, donnees.client_reference, async (t) => {
    const wo = await chargerPourProprietaire(WorkOrder, workOrderId, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Travaux');
    if (wo.status === 'annule') throw new ConflictError('Impossible d’enregistrer une dépense sur des travaux annulés.', 'TRAVAUX_ANNULES');
    const categoryId = donnees.category_id || (await categories.globaleParCode('travaux', t)).id;
    return creerDansTransaction(t, ownerId, user, {
      ...donnees,
      category_id: categoryId,
      building_id: wo.building_id,
      apartment_id: wo.apartment_id,
      contractor_id: donnees.contractor_id || wo.contractor_id,
      work_order_id: wo.id,
      description: donnees.description || `Travaux #${pad(wo.number)} — ${wo.title}`.slice(0, 500),
    });
  });
}

/** Modification des seuls champs DESCRIPTIFS (voir l'en-tête du fichier). */
async function modifier(id, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const expense = await chargerPourProprietaire(Expense, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Dépense');
    if (expense.status === 'annulee') throw new ConflictError('Une dépense annulée ne se modifie plus.', 'DEPENSE_ANNULEE');

    // Seul un CHANGEMENT de catégorie exige une catégorie active : une dépense
    // dont la catégorie a été désactivée depuis (§ 42) reste corrigible.
    const changeCategorie = Boolean(donnees.category_id) && donnees.category_id !== expense.category_id;
    const categorie = changeCategorie
      ? await categories.resoudre(donnees.category_id, ownerId, t)
      : await ExpenseCategory.findByPk(expense.category_id, { transaction: t });
    if (donnees.apartment_id) {
      const apartment = await verifierReference(Apartment, donnees.apartment_id, ownerId, 'Appartement', { transaction: t });
      if (apartment.building_id !== expense.building_id) {
        throw new ValidationError('Données invalides', ["L'appartement n'appartient pas à l'immeuble de la dépense"]);
      }
    }
    if (donnees.contractor_id) await verifierReference(Contractor, donnees.contractor_id, ownerId, 'Artisan', { transaction: t });

    const avant = expense.toJSON();
    await expense.update(donnees, { transaction: t, fields: CHAMPS_MODIFIABLES });

    // Le mouvement de caisse suit la classification (catégorie → groupe § 21),
    // l'appartement et le libellé ; jamais le montant.
    await CashMovement.update({
      category: GROUPE_VERS_CAISSE[categorie.cash_group],
      apartment_id: expense.apartment_id,
      label: libelleCaisse(categorie, expense.description).slice(0, 200),
    }, { where: { source_type: 'expense', source_id: id, cancelled_at: null }, transaction: t });

    await journaliser({ action: 'depense.modification', entityType: 'expense', entityId: id, ownerId, details: difference(avant, donnees, CHAMPS_MODIFIABLES) }, t);
    return expense;
  }).then((e) => chargerPropre(e.id, ownerId));
}

/** Annulation motivée (§ 42) : la dépense ET sa sortie de caisse. */
async function annuler(id, ownerId, user, motif) {
  return sequelize.transaction(async (t) => {
    const expense = await chargerPourProprietaire(Expense, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Dépense');
    if (expense.status === 'annulee') throw new ConflictError('Cette dépense est déjà annulée.', 'DEJA_ANNULEE');
    await expense.update({ status: 'annulee', cancelled_at: new Date(), cancel_reason: motif, cancelled_by: user.id }, { transaction: t });
    const mouvements = await caisse.annulerParSource(t, 'expense', id);
    await journaliser({
      action: 'depense.changement_statut', entityType: 'expense', entityId: id, ownerId,
      details: { avant: 'valide', apres: 'annulee', motif, montant: expense.amount, mouvements_caisse_annules: mouvements },
    }, t);
    return expense;
  }).then((e) => chargerPropre(e.id, ownerId));
}

/** Justificatif (§ 20 « Justificatif : photo ») : image ou PDF. */
async function ajouterJustificatif(id, ownerId, user, fichier) {
  return transactionAvecFichiers(async (t) => {
    const expense = await chargerPourProprietaire(Expense, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Dépense');
    if (expense.status === 'annulee') throw new ConflictError('Une dépense annulée ne reçoit plus de justificatif.', 'DEPENSE_ANNULEE');
    const document = await documents.creerDocument({
      ownerId, entityType: 'expense', entityId: id, category: 'justificatif', fichier, uploadedBy: user.id,
    }, t);
    return documents.versApi(document);
  });
}

module.exports = {
  lister, detail, creer, creerPourTravaux, modifier, annuler, ajouterJustificatif, GROUPE_VERS_CAISSE,
};
