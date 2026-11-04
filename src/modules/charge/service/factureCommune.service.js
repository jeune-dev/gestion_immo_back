'use strict';

const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  ChargeInvoice, ChargeAllocation, Charge, Building, Apartment, Lease, Tenant, Expense,
} = require('../../../models/index.js');
const { TYPE_CHARGE, METHODE_REPARTITION } = require('../../../config/enums.js');
const { chargerPourProprietaire, verifierReference } = require('../../../utils/acces.js');
const { ordre, rechercheTexte } = require('../../../utils/liste.js');
const { aujourdhui, ajouterJours, libelleMois, formatFr } = require('../../../utils/dates.js');
const { formatFcfa } = require('../../../utils/montants.js');
const {
  ConflictError, ValidationError, ForbiddenError,
} = require('../../../errors/AppError.js');
const { transactionAvecFichiers } = require('../../../database/transaction.js');
const documents = require('../../document/service/document.service.js');
const depenses = require('../../depense/service/depense.service.js');
const categories = require('../../depense/service/categorie.service.js');
const parametres = require('../../parametres/service/parametres.service.js');
const { notifier, destinataireLocataire } = require('../../notification/service/notification.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');
const { calculerRepartition, statutCharge, uniteParDefaut } = require('./repartition.calcul.js');

/**
 * Factures communes (§ 16) et leur répartition (§ 17) :
 *
 *   brouillon ──répartir──▶ repartie
 *       │                      │ (aucune charge encaissée)
 *       └──────annuler─────────┴──▶ annulee
 *
 * - La méthode de répartition est OBLIGATOIRE dès la saisie (§ 41) et fixée
 *   sur la facture : l'aperçu et la répartition l'utilisent, le client ne
 *   fournit que les données propres à la méthode (consommations, surcharges).
 * - La répartition est explicable (§ 17) : une ligne `charge_allocations` par
 *   appartement avec la base (basis_value), la part (share), le montant et
 *   une explication en français.
 * - Refacturation (`recharge_to_tenants`) : une ligne `charges` par
 *   appartement OCCUPÉ sur la période. La part d'un appartement VACANT reste à
 *   la charge du propriétaire : elle est tracée dans `charge_allocations`
 *   (lease_id NULL) mais ne produit aucune charge locataire — personne ne
 *   peut la payer, et la faire porter aux autres locataires fausserait leur
 *   part.
 * - Une facture répartie n'est plus modifiable (409) : pour corriger, on
 *   l'annule (si aucune charge n'a été encaissée) et on en saisit une autre.
 * - La répartition crée la DÉPENSE de la facture et sa sortie de caisse : le coût
 *   entre dans le résultat, face aux charges récupérées. Annuler la facture annule
 *   cette dépense. Ne pas la saisir une seconde fois à la main.
 * - La provision de charges déjà appelée sur la période pour un bail est déduite
 *   de sa part refacturée ; une provision déduite ne sert qu'une fois.
 */

const CHAMPS = [
  'building_id', 'charge_type', 'supplier', 'invoice_number', 'period_start', 'period_end',
  'amount', 'due_date', 'allocation_method', 'recharge_to_tenants', 'notes',
];

/** Délai de paiement d'une charge refacturée quand la facture n'a pas d'échéance. */
const DELAI_PAIEMENT_JOURS = 15;

/**
 * Fenêtre pendant laquelle une demande de paiement expirée (« annulee » par le
 * job) peut encore être confirmée par le fournisseur : aucune annulation de
 * facture tant qu'elle n'est pas écoulée.
 */
const DELAI_CONFIRMATION_TARDIVE = '24 hours';

const INCLUDE_IMMEUBLE = { model: Building, as: 'building', attributes: ['id', 'name'], paranoid: false };

/**
 * Nombre et somme des lignes de répartition, et refacturation, calculés DANS
 * la requête (sous-requêtes corrélées indexées) : une requête pour toute la
 * page, jamais une par facture (pas de N+1).
 */
const ATTRIBUTS_TOTAUX = [
  [sequelize.literal('(SELECT count(*) FROM charge_allocations ca WHERE ca.charge_invoice_id = "ChargeInvoice"."id")'), 'allocations_count'],
  [sequelize.literal('(SELECT COALESCE(sum(ca.amount), 0) FROM charge_allocations ca WHERE ca.charge_invoice_id = "ChargeInvoice"."id")'), 'allocations_total'],
  [sequelize.literal('(SELECT COALESCE(sum(c.amount), 0) FROM charges c WHERE c.charge_invoice_id = "ChargeInvoice"."id" AND c.status <> \'annule\')'), 'recharged_total'],
  [sequelize.literal('(SELECT COALESCE(sum(c.amount_paid), 0) FROM charges c WHERE c.charge_invoice_id = "ChargeInvoice"."id" AND c.status <> \'annule\')'), 'recharged_paid'],
];

/** Type de charge → catégorie de dépense globale (seeders). */
const CATEGORIE_DEPENSE = Object.freeze({
  eau: 'facture_eau',
  electricite: 'facture_electricite',
  nettoyage: 'nettoyage',
  securite: 'securite',
  ascenseur: 'ascenseur',
  entretien: 'entretien',
  internet: 'internet',
  gardiennage: 'gardiennage',
  autre: 'autre',
});

const videVersNull = (v) => (v === '' ? null : v);

function normaliser(donnees) {
  const d = { ...donnees };
  for (const cle of ['supplier', 'invoice_number', 'notes']) if (cle in d) d[cle] = videVersNull(d[cle]);
  return d;
}

// ── Lecture ──────────────────────────────────────────────────────────────────

async function lister(ownerId, f, { limit, offset }) {
  const where = { owner_id: ownerId };
  for (const cle of ['building_id', 'status', 'charge_type']) if (f[cle]) where[cle] = f[cle];
  // Période : factures dont [period_start, period_end] chevauche [du, au].
  if (f.du) where.period_end = { [Op.gte]: f.du };
  if (f.au) where.period_start = { [Op.lte]: f.au };
  const texte = rechercheTexte(f.q, ['supplier', 'invoice_number']);
  if (texte) Object.assign(where, texte);

  return ChargeInvoice.findAndCountAll({
    where,
    attributes: { include: ATTRIBUTS_TOTAUX },
    include: [INCLUDE_IMMEUBLE],
    order: ordre(f.tri, '-period_start'),
    limit,
    offset,
  });
}

/**
 * § 48 « Quelle facture dois-je répartir ? » : factures en brouillon, les plus
 * anciennes d'abord, avec leur nombre et leur montant cumulé.
 */
async function aRepartir(ownerId) {
  const where = { owner_id: ownerId, status: 'brouillon' };
  const [{ rows, count }, montant] = await Promise.all([
    ChargeInvoice.findAndCountAll({
      where,
      include: [INCLUDE_IMMEUBLE],
      order: [['period_start', 'ASC'], ['created_at', 'ASC'], ['id', 'ASC']],
      limit: 100,
    }),
    ChargeInvoice.sum('amount', { where }),
  ]);
  return { count, total_amount: montant || 0, invoices: rows };
}

async function detail(id, ownerId) {
  const invoice = await chargerPourProprietaire(ChargeInvoice, id, ownerId, {
    attributes: { include: ATTRIBUTS_TOTAUX },
    include: [INCLUDE_IMMEUBLE],
  }, 'Facture commune');

  const [allocations, charges, pieces] = await Promise.all([
    ChargeAllocation.findAll({
      where: { charge_invoice_id: id },
      include: [
        { model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false },
        {
          model: Lease, as: 'lease', attributes: ['id', 'reference', 'tenant_id'],
          include: [{ model: Tenant, as: 'tenant', attributes: ['id', 'first_name', 'last_name'], paranoid: false }],
        },
      ],
      order: [[{ model: Apartment, as: 'apartment' }, 'number', 'ASC'], ['id', 'ASC']],
    }),
    Charge.findAll({
      where: { charge_invoice_id: id },
      attributes: ['id', 'charge_allocation_id', 'tenant_id', 'amount', 'amount_paid', 'due_date', 'status'],
    }),
    documents.listerPourEntite('charge_invoice', id),
  ]);

  const chargeParLigne = new Map(charges.map((c) => [c.charge_allocation_id, c.toJSON()]));
  return {
    ...invoice.toJSON(),
    method_label: METHODE_REPARTITION[invoice.allocation_method],
    allocations: allocations.map((a) => ({ ...a.toJSON(), charge: chargeParLigne.get(a.id) || null })),
    documents: pieces.map(documents.versApi),
  };
}

// ── Saisie ───────────────────────────────────────────────────────────────────

/**
 * Même facture déjà saisie : même immeuble, type, période, montant et fournisseur,
 * sans deux numéros différents pour les distinguer. L'index unique ne couvre que le
 * cas d'un numéro identique. Verrou consultatif : deux saisies simultanées passent
 * l'une après l'autre.
 */
async function refuserDoublon(t, ownerId, f, idExclu = null) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:cle))', { replacements: { cle: `facture:${f.building_id}` }, transaction: t });
  const [doublon] = await sequelize.query(`
    SELECT id FROM charge_invoices
     WHERE owner_id = :ownerId AND building_id = :buildingId AND charge_type = :type
       AND period_start = :debut AND period_end = :fin AND amount = :montant
       AND status <> 'annulee'
       AND lower(COALESCE(supplier, '')) = lower(:fournisseur)
       AND (invoice_number IS NULL OR CAST(:numero AS text) IS NULL OR invoice_number = :numero)
       AND (CAST(:idExclu AS uuid) IS NULL OR id <> CAST(:idExclu AS uuid))
     LIMIT 1`,
  {
    replacements: {
      ownerId, buildingId: f.building_id, type: f.charge_type, debut: f.period_start, fin: f.period_end, montant: f.amount,
      fournisseur: f.supplier || '', numero: f.invoice_number || null, idExclu,
    },
    type: QueryTypes.SELECT,
    transaction: t,
  });
  if (doublon) {
    throw new ConflictError(
      'Cette facture semble déjà saisie (même immeuble, type, période, montant et fournisseur). Indiquez son numéro si c’en est une autre.',
      'FACTURE_EN_DOUBLE',
      { invoice_id: doublon.id }
    );
  }
}

async function creer(ownerId, user, donnees) {
  return sequelize.transaction(async (t) => {
    const building = await verifierReference(Building, donnees.building_id, ownerId, 'Immeuble', { transaction: t });
    await refuserDoublon(t, ownerId, normaliser(donnees));
    const invoice = await ChargeInvoice.create({
      ...normaliser(donnees),
      owner_id: ownerId,
      status: 'brouillon',
      created_by: user.id,
    }, { transaction: t });
    await journaliser({
      action: 'facture_commune.creation', entityType: 'charge_invoice', entityId: invoice.id, ownerId,
      details: {
        immeuble: building.name, type: invoice.charge_type, fournisseur: invoice.supplier,
        montant: invoice.amount, methode: invoice.allocation_method,
      },
    }, t);
    return invoice;
  });
}

function exigerBrouillon(invoice, action) {
  if (invoice.status === 'annulee') throw new ConflictError('Cette facture est annulée.', 'FACTURE_ANNULEE');
  if (invoice.status !== 'brouillon') {
    throw new ConflictError(
      `Cette facture est déjà répartie : impossible de ${action}. Annulez-la (si aucune charge n'a été encaissée) puis saisissez-en une nouvelle.`,
      'FACTURE_DEJA_REPARTIE'
    );
  }
}

async function modifier(id, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const invoice = await chargerPourProprietaire(ChargeInvoice, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Facture commune');
    exigerBrouillon(invoice, 'la modifier');
    if (donnees.building_id && donnees.building_id !== invoice.building_id) {
      await verifierReference(Building, donnees.building_id, ownerId, 'Immeuble', { transaction: t });
    }
    const fusion = { ...invoice.toJSON(), ...donnees };
    if (fusion.period_end < fusion.period_start) {
      throw new ValidationError('Données invalides', ['La fin de période doit être postérieure ou égale au début de période']);
    }
    await refuserDoublon(t, ownerId, normaliser(fusion), id);
    const avant = invoice.toJSON();
    const valeurs = normaliser(donnees);
    await invoice.update(valeurs, { transaction: t, fields: CHAMPS });
    await journaliser({
      action: 'facture_commune.modification', entityType: 'charge_invoice', entityId: id, ownerId,
      details: difference(avant, valeurs, CHAMPS),
    }, t);
    return invoice;
  });
}

/** Justificatif (facture du fournisseur scannée ou PDF) — § 16. */
async function ajouterDocument(id, ownerId, user, fichier) {
  return transactionAvecFichiers(async (t) => {
    const invoice = await chargerPourProprietaire(ChargeInvoice, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Facture commune');
    // Un justificatif ne change aucun montant : il reste accepté après la
    // répartition (scan reçu plus tard), mais plus sur une facture annulée.
    if (invoice.status === 'annulee') throw new ConflictError('Cette facture est annulée.', 'FACTURE_ANNULEE');
    const document = await documents.creerDocument({
      ownerId, entityType: 'charge_invoice', entityId: id, category: 'facture',
      fichier, visibleToTenant: false, uploadedBy: user.id,
    }, t);
    return documents.versApi(document);
  });
}

// ── Répartition ──────────────────────────────────────────────────────────────

/**
 * Baux « actifs sur la période » de la facture, un par appartement, en UNE
 * requête (DISTINCT ON). Un bail compte s'il chevauche la période (début avant
 * la fin de période, pas terminé avant son début) ; s'il y en a plusieurs
 * (changement de locataire en cours de mois), on retient celui qui est en
 * cours à la FIN de la période — c'est l'occupant qui reçoit la facture —,
 * sinon le plus récent. Un bail « actif » n'a pas de date de sortie : il
 * couvre toujours la fin de période s'il a commencé avant.
 *
 * @returns {Promise<Map<string, object>>} apartment_id → bail + locataire
 */
async function bauxSurPeriode(ownerId, apartmentIds, debut, fin, t) {
  if (!apartmentIds.length) return new Map();
  const lignes = await sequelize.query(`
    SELECT DISTINCT ON (l.apartment_id)
           l.id, l.apartment_id, l.tenant_id, l.reference, l.occupants_count,
           tn.first_name, tn.last_name, tn.user_id
      FROM leases l
      JOIN tenants tn ON tn.id = l.tenant_id
     WHERE l.owner_id = :ownerId
       AND l.apartment_id IN (:apartmentIds)
       AND l.status IN ('actif', 'termine', 'clos')
       AND l.start_date <= CAST(:fin AS date)
       AND (l.ended_on IS NULL OR l.ended_on >= CAST(:debut AS date))
     ORDER BY l.apartment_id,
              (l.ended_on IS NULL OR l.ended_on >= CAST(:fin AS date)) DESC,
              l.start_date DESC`,
  { replacements: { ownerId, apartmentIds, debut, fin }, type: QueryTypes.SELECT, transaction: t });
  return new Map(lignes.map((l) => [l.apartment_id, l]));
}

/**
 * Provision de charges encore déductible par bail sur la période : provisions
 * des échéances qui la chevauchent, moins ce que les factures réparties
 * chevauchant la même période en ont déjà pris.
 * @returns {Promise<Map<string, number>>} lease_id → montant disponible
 */
async function provisionsDisponibles(leaseIds, debut, fin, t) {
  if (!leaseIds.length) return new Map();
  const lignes = await sequelize.query(`
    SELECT l.id,
           COALESCE((SELECT sum(rs.charges_amount) FROM rent_schedules rs
                      WHERE rs.lease_id = l.id AND rs.status <> 'annule'
                        AND rs.period_start <= CAST(:fin AS date) AND rs.period_end >= CAST(:debut AS date)), 0)
         - COALESCE((SELECT sum(ca.provision_deducted) FROM charge_allocations ca
                       JOIN charge_invoices ci ON ci.id = ca.charge_invoice_id
                      WHERE ca.lease_id = l.id AND ci.status = 'repartie'
                        AND ci.period_start <= CAST(:fin AS date) AND ci.period_end >= CAST(:debut AS date)), 0) AS disponible
      FROM leases l WHERE l.id IN (:leaseIds)`,
  { replacements: { leaseIds, debut, fin }, type: QueryTypes.SELECT, transaction: t });
  return new Map(lignes.map((l) => [l.id, Math.max(0, l.disponible)]));
}

/**
 * Charge et contrôle les appartements désignés par le client (UNE requête) :
 * inexistant → 422, autre propriétaire → 403, autre immeuble → 422.
 */
async function appartementsDesignes(ids, invoice, ownerId, t) {
  const trouves = await Apartment.findAll({
    where: { id: ids },
    attributes: ['id', 'owner_id', 'building_id', 'number', 'charge_coefficient'],
    transaction: t,
  });
  const parId = new Map(trouves.map((a) => [a.id, a]));
  for (const id of ids) {
    const a = parId.get(id);
    if (!a) throw new ValidationError('Données invalides', [`Appartement introuvable (${id})`], 'APPARTEMENT_INTROUVABLE');
    if (a.owner_id !== ownerId) throw new ForbiddenError("Vous n'avez pas accès à cette ressource.", 'ACCES_AUTRE_PROPRIETAIRE');
    if (a.building_id !== invoice.building_id) {
      throw new ValidationError('Données invalides', [`L'appartement ${a.number} n'appartient pas à l'immeuble de la facture`], 'APPARTEMENT_HORS_IMMEUBLE');
    }
  }
  return parId;
}

const parNumero = (a, b) => a.number.localeCompare(b.number, 'fr', { numeric: true }) || a.id.localeCompare(b.id);

/**
 * Construit les lignes de calcul d'une facture (sans rien écrire) : sélection
 * des appartements, base de chaque méthode, baux sur la période, puis calcul
 * pur (`calculerRepartition`).
 */
async function preparer(invoice, ownerId, params, t) {
  const methode = invoice.allocation_method;
  const lignesCorps = params.lines || [];
  const surcharges = new Map(lignesCorps.map((l) => [l.apartment_id, l]));
  const parLignes = ['consommation', 'personnalise'].includes(methode);

  if (parLignes && !lignesCorps.length) {
    throw new ValidationError('Répartition impossible', [
      methode === 'consommation'
        ? 'Indiquez la consommation de chaque appartement (lines[].consumption).'
        : 'Indiquez le montant de chaque appartement (lines[].amount).',
    ], 'LIGNES_REQUISES');
  }

  // Sélection : les lignes pour consommation / personnalisé ; sinon la liste
  // fournie ou, par défaut, tous les appartements (non supprimés) de l'immeuble.
  let selection;
  if (parLignes || params.apartment_ids) {
    const ids = parLignes ? lignesCorps.map((l) => l.apartment_id) : params.apartment_ids;
    const designes = await appartementsDesignes([...new Set([...ids, ...surcharges.keys()])], invoice, ownerId, t);
    if (!parLignes) {
      const hors = [...surcharges.keys()].filter((id) => !ids.includes(id));
      if (hors.length) {
        throw new ValidationError('Répartition impossible', [`Appartement ${designes.get(hors[0]).number} présent dans lines mais absent de apartment_ids`], 'APPARTEMENT_HORS_SELECTION');
      }
    }
    selection = ids.map((id) => designes.get(id));
  } else {
    if (surcharges.size) await appartementsDesignes([...surcharges.keys()], invoice, ownerId, t);
    selection = await Apartment.findAll({
      where: { building_id: invoice.building_id, owner_id: ownerId },
      attributes: ['id', 'owner_id', 'building_id', 'number', 'charge_coefficient'],
      transaction: t,
    });
  }
  // Ordre stable (numéro d'appartement) : l'écart d'arrondi au franc est
  // attribué de façon reproductible, le calcul reste explicable (§ 17).
  selection = [...selection].sort(parNumero);

  const baux = await bauxSurPeriode(ownerId, selection.map((a) => a.id), invoice.period_start, invoice.period_end, t);

  const valeur = (a) => {
    const s = surcharges.get(a.id);
    const manque = (champ, libelle) => {
      throw new ValidationError('Répartition impossible', [`${libelle} manquant(e) pour l'appartement ${a.number} (lines[].${champ}).`], 'VALEUR_MANQUANTE');
    };
    switch (methode) {
      case 'consommation': return s.consumption ?? manque('consumption', 'Consommation');
      case 'personnalise': return s.amount ?? manque('amount', 'Montant');
      case 'coefficient': return s?.coefficient ?? Number(a.charge_coefficient);
      // Vacant sur la période → 0 occupant → part nulle (sauf surcharge explicite).
      case 'occupants': return s?.occupants ?? (baux.get(a.id)?.occupants_count || 0);
      default: return 1;
    }
  };

  const resultat = calculerRepartition(
    methode,
    invoice.amount,
    selection.map((a) => ({
      apartment_id: a.id,
      numero: a.number,
      valeur: valeur(a),
      vacant: !baux.has(a.id) && surcharges.get(a.id)?.occupants === undefined,
    })),
    { unite: params.unit || uniteParDefaut(invoice.charge_type) }
  );

  const provisions = invoice.recharge_to_tenants
    ? await provisionsDisponibles([...baux.values()].map((b) => b.id), invoice.period_start, invoice.period_end, t)
    : new Map();

  const lignes = resultat.lignes.map((l) => {
    const bail = baux.get(l.apartment_id) || null;
    const aRefacturer = Boolean(invoice.recharge_to_tenants && bail && l.amount > 0);
    const provision = aRefacturer ? Math.min(provisions.get(bail.id) || 0, l.amount) : 0;
    const net = l.amount - provision;
    return {
      ...l,
      bail,
      provision_deducted: provision,
      net,
      explanation: provision > 0
        ? `${l.explanation}. Provision déjà appelée déduite : ${formatFcfa(provision)}, reste à payer : ${formatFcfa(net)}`
        : l.explanation,
      // Seul un appartement occupé sur la période reçoit une charge ; la part
      // d'un logement vacant reste au propriétaire. Couverte par la provision,
      // la part ne laisse rien à payer.
      refacturee: aRefacturer && net > 0,
    };
  });
  return { resultat, lignes };
}

/** Représentation d'API d'un calcul (aperçu et réponse de répartition). */
function versApiCalcul(invoice, { resultat, lignes }) {
  const refacture = lignes.filter((l) => l.refacturee).reduce((s, l) => s + l.net, 0);
  const provisions = lignes.reduce((s, l) => s + l.provision_deducted, 0);
  return {
    invoice_id: invoice.id,
    allocation_method: resultat.methode,
    method_label: METHODE_REPARTITION[resultat.methode],
    total: resultat.total,
    basis_total: resultat.base_totale,
    apartments_count: lignes.length,
    recharged_total: refacture,
    provision_deducted_total: provisions,
    owner_share: resultat.total - refacture - provisions,
    lines: lignes.map((l) => ({
      apartment_id: l.apartment_id,
      apartment_number: l.numero,
      basis_value: l.basis_value,
      share: l.share,
      amount: l.amount,
      provision_deducted: l.provision_deducted,
      net_amount: l.net,
      explanation: l.explanation,
      lease_id: l.bail?.id || null,
      tenant: l.bail ? { id: l.bail.tenant_id, first_name: l.bail.first_name, last_name: l.bail.last_name } : null,
      recharged: l.refacturee,
    })),
  };
}

/** Aperçu SANS enregistrement (§ 17 « le calcul soit explicable »). */
async function apercu(id, ownerId, params) {
  const invoice = await chargerPourProprietaire(ChargeInvoice, id, ownerId, {}, 'Facture commune');
  exigerBrouillon(invoice, 'la répartir à nouveau');
  return versApiCalcul(invoice, await preparer(invoice, ownerId, params));
}

/** « Électricité septembre 2026 — SENELEC » */
function libelleCharge(invoice) {
  const type = invoice.charge_type === 'autre' ? 'Charges communes' : TYPE_CHARGE[invoice.charge_type];
  const debut = libelleMois(invoice.period_start);
  const fin = libelleMois(invoice.period_end);
  const periode = debut === fin ? debut : `${debut} – ${fin}`;
  return `${type} ${periode}${invoice.supplier ? ` — ${invoice.supplier}` : ''}`.slice(0, 150);
}

/** Dépense et sortie de caisse d'une facture répartie (dans la transaction de l'appelant). */
async function creerDepenseFacture(t, invoice, user, { methode, date, silencieux = false }) {
  const categorie = await categories.globaleParCode(CATEGORIE_DEPENSE[invoice.charge_type], t);
  return depenses.creerDansTransaction(t, invoice.owner_id, user, {
    building_id: invoice.building_id,
    category_id: categorie.id,
    amount: invoice.amount,
    method: methode || 'autre',
    spent_on: date,
    description: `Facture commune — ${libelleCharge(invoice)}`.slice(0, 500),
    charge_invoice_id: invoice.id,
    silencieux,
  });
}

/**
 * Notifie chaque locataire concerné, UNE notification par locataire (un
 * locataire de deux appartements reçoit le total de ses parts).
 */
async function notifierLocataires(t, ownerId, lignesParLocataire, { titre, corps, donnees }) {
  for (const { locataire, montant, chargeIds } of lignesParLocataire.values()) {
    await notifier(t, {
      destinataires: [destinataireLocataire(locataire)],
      ownerId,
      type: 'facture',
      titre,
      corps: corps(montant),
      donnees: { ...donnees, charge_ids: chargeIds },
    });
  }
}

/**
 * Effectue la répartition : lignes explicables, charges locataires, statut
 * « repartie ». Une transaction, facture verrouillée : deux répartitions
 * simultanées ne peuvent pas produire deux jeux de lignes.
 */
async function repartir(id, ownerId, user, params) {
  await sequelize.transaction(async (t) => {
    const invoice = await chargerPourProprietaire(ChargeInvoice, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Facture commune');
    exigerBrouillon(invoice, 'la répartir à nouveau');
    // Deux factures réparties en même temps ne déduisent pas deux fois la même provision.
    await sequelize.query(
      `SELECT l.id FROM leases l JOIN apartments a ON a.id = l.apartment_id
        WHERE l.owner_id = :ownerId AND a.building_id = :buildingId AND l.status IN ('actif', 'termine', 'clos')
        ORDER BY l.id FOR UPDATE OF l`,
      { replacements: { ownerId, buildingId: invoice.building_id }, type: QueryTypes.SELECT, transaction: t }
    );
    const calcul = await preparer(invoice, ownerId, params, t);
    const { resultat, lignes } = calcul;

    const allocations = await ChargeAllocation.bulkCreate(lignes.map((l) => ({
      owner_id: ownerId,
      charge_invoice_id: id,
      apartment_id: l.apartment_id,
      // Bail de l'occupant sur la période ; NULL = logement vacant, part
      // supportée par le propriétaire.
      lease_id: l.bail?.id || null,
      basis_value: l.basis_value,
      share: l.share,
      amount: l.amount,
      provision_deducted: l.provision_deducted,
      explanation: l.explanation,
    })), { transaction: t, returning: true });

    const aRefacturer = lignes.map((l, i) => ({ ...l, allocation: allocations[i] })).filter((l) => l.refacturee);
    const jour = aujourdhui();
    const echeance = invoice.due_date || ajouterJours(jour, DELAI_PAIEMENT_JOURS);
    const { late_grace_days: grace } = await parametres.proprietaire(ownerId, t);
    const libelle = libelleCharge(invoice);

    const charges = aRefacturer.length ? await Charge.bulkCreate(aRefacturer.map((l) => ({
      owner_id: ownerId,
      lease_id: l.bail.id,
      tenant_id: l.bail.tenant_id,
      apartment_id: l.apartment_id,
      charge_invoice_id: id,
      charge_allocation_id: l.allocation.id,
      charge_type: invoice.charge_type,
      label: libelle,
      amount: l.net,
      amount_paid: 0,
      due_date: echeance,
      status: statutCharge({ amount: l.net, amount_paid: 0, due_date: echeance }, jour, grace ?? 0),
    })), { transaction: t, returning: true }) : [];

    await invoice.update({ status: 'repartie', allocated_at: new Date() }, { transaction: t });

    await creerDepenseFacture(t, invoice, user, { methode: params.payment_method, date: jour });

    const refacture = charges.reduce((s, c) => s + Number(c.amount), 0);
    const provisionsDeduites = lignes.reduce((s, l) => s + l.provision_deducted, 0);
    await journaliser({
      action: 'facture_commune.repartition', entityType: 'charge_invoice', entityId: id, ownerId,
      details: {
        methode: resultat.methode,
        montant: resultat.total,
        base_totale: resultat.base_totale,
        appartements: lignes.length,
        total_reparti: lignes.reduce((s, l) => s + l.amount, 0),
        charges_creees: charges.length,
        refacture,
        provisions_deduites: provisionsDeduites,
        a_la_charge_du_proprietaire: resultat.total - refacture - provisionsDeduites,
      },
    }, t);

    const parLocataire = new Map();
    charges.forEach((c, i) => {
      const bail = aRefacturer[i].bail;
      const entree = parLocataire.get(bail.tenant_id)
        || { locataire: { id: bail.tenant_id, user_id: bail.user_id }, montant: 0, chargeIds: [] };
      entree.montant += Number(c.amount);
      entree.chargeIds.push(c.id);
      parLocataire.set(bail.tenant_id, entree);
    });
    await notifierLocataires(t, ownerId, parLocataire, {
      titre: `Nouvelle charge : ${libelle}`.slice(0, 150),
      corps: (montant) => `Votre part de la facture « ${libelle} » s'élève à ${formatFcfa(montant)}, à régler avant le ${formatFr(echeance)}. Le détail du calcul est disponible dans « Mes charges ».`,
      donnees: { charge_invoice_id: id },
    });
  });
  return detail(id, ownerId);
}

/**
 * Annulation LOGIQUE (§ 42) — jamais de suppression d'une donnée financière.
 * Brouillon : toujours possible. Répartie : seulement si aucune charge n'a
 * été encaissée ni n'a de paiement en cours ; les charges générées passent
 * alors « annule ». Les lignes de répartition restent (historique).
 */
async function annuler(id, ownerId, user, motif) {
  return sequelize.transaction(async (t) => {
    const invoice = await chargerPourProprietaire(ChargeInvoice, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Facture commune');
    if (invoice.status === 'annulee') throw new ConflictError('Facture déjà annulée', 'DEJA_ANNULE');
    const avant = invoice.status;

    let charges = [];
    if (avant === 'repartie') {
      charges = await Charge.findAll({
        where: { charge_invoice_id: id, status: { [Op.ne]: 'annule' } },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (charges.some((c) => c.amount_paid > 0)) {
        throw new ConflictError(
          'Une charge de cette facture a déjà été encaissée : remboursez d’abord le paiement avant d’annuler la facture.',
          'CHARGE_ENCAISSEE'
        );
      }
      if (charges.length) {
        // Un paiement « en cours » inclut une demande que le job d'expiration
        // vient de passer « annulee » : le fournisseur peut encore confirmer
        // tardivement (§ 51.3), la charge serait alors payée sur une facture
        // annulée. On attend donc DELAI_CONFIRMATION_TARDIVE après sa création.
        const [enCours] = await sequelize.query(
          `SELECT 1 FROM payment_transactions
            WHERE charge_id IN (:ids)
              AND (status IN ('initiee', 'en_attente')
                   OR (status = 'annulee' AND created_at > now() - CAST(:delai AS interval)))
            LIMIT 1`,
          { replacements: { ids: charges.map((c) => c.id), delai: DELAI_CONFIRMATION_TARDIVE }, type: QueryTypes.SELECT, transaction: t }
        );
        if (enCours) {
          throw new ConflictError('Un paiement est en cours sur une charge de cette facture : attendez sa confirmation ou son échec.', 'PAIEMENT_EN_COURS');
        }
        await Charge.update(
          { status: 'annule', cancelled_at: new Date() },
          { where: { id: charges.map((c) => c.id) }, transaction: t }
        );
      }
    }

    const depense = await Expense.findOne({ where: { charge_invoice_id: id, status: 'valide' }, transaction: t, lock: t.LOCK.UPDATE });
    if (depense) await depenses.annulerDansTransaction(t, depense, user, `Facture commune annulée : ${motif}`);

    // Le motif est conservé sur la facture (visible du propriétaire) et au journal.
    const trace = `Annulée le ${formatFr(aujourdhui())} : ${motif}`;
    await invoice.update({
      status: 'annulee',
      notes: invoice.notes ? `${invoice.notes}\n${trace}` : trace,
    }, { transaction: t });
    await journaliser({
      action: 'facture_commune.changement_statut', entityType: 'charge_invoice', entityId: id, ownerId,
      details: { avant, apres: 'annulee', motif, charges_annulees: charges.length, montant: invoice.amount },
    }, t);

    if (charges.length) {
      const locataires = await Tenant.findAll({
        where: { id: [...new Set(charges.map((c) => c.tenant_id))] },
        attributes: ['id', 'user_id'],
        paranoid: false,
        transaction: t,
      });
      const parId = new Map(locataires.map((l) => [l.id, l]));
      const parLocataire = new Map();
      for (const c of charges) {
        const entree = parLocataire.get(c.tenant_id) || { locataire: parId.get(c.tenant_id), montant: 0, chargeIds: [] };
        entree.montant += Number(c.amount);
        entree.chargeIds.push(c.id);
        parLocataire.set(c.tenant_id, entree);
      }
      const libelle = libelleCharge(invoice);
      await notifierLocataires(t, ownerId, parLocataire, {
        titre: `Charge annulée : ${libelle}`.slice(0, 150),
        corps: (montant) => `La charge « ${libelle} » (${formatFcfa(montant)}) a été annulée par votre bailleur. Vous n'avez rien à régler à ce titre.`,
        donnees: { charge_invoice_id: id },
      });
    }
    return invoice;
  });
}

module.exports = {
  lister, aRepartir, detail, creer, modifier, ajouterDocument, apercu, repartir, annuler,
  libelleCharge, bauxSurPeriode, creerDepenseFacture,
};
