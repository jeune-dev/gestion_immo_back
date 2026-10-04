'use strict';

const { Op } = require('sequelize');
const {
  LeaseTemplate, LeaseDocument, Apartment, Building, Tenant, Owner, Inspection,
} = require('../../../models/index.js');
const { TYPE_BAIL, PERIODICITE, TYPE_APPARTEMENT, TYPE_PIECE_IDENTITE } = require('../../../config/enums.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { formatFr, aujourdhui, ecartJours } = require('../../../utils/dates.js');
const { ConflictError, ValidationError } = require('../../../errors/AppError.js');
const pdf = require('../../../infrastructure/pdf.service.js');

/**
 * Modèle de bail conforme (§ 53) : génération d'un contrat à partir des
 * données déjà saisies (propriétaire, locataire, appartement, loyer, caution,
 * dates).
 *
 * - Les modèles sont VERSIONNÉS : chaque contrat conserve la version utilisée
 *   ET le texte rendu (`lease_documents.content`) ; publier une nouvelle
 *   version n'altère jamais un bail existant (§ 56.2).
 * - Les clauses particulières du propriétaire sont ajoutées dans une section
 *   distincte, clairement séparée du texte du modèle (§ 53.4).
 */

/** Catalogue des variables disponibles dans un modèle (contrôlé à la publication). */
const VARIABLES = Object.freeze([
  'bailleur.nom', 'bailleur.telephone', 'bailleur.email', 'bailleur.adresse',
  'locataire.nom', 'locataire.telephone', 'locataire.email', 'locataire.piece_identite',
  'bien.immeuble', 'bien.adresse', 'bien.ville', 'bien.numero', 'bien.etage', 'bien.type',
  'bien.surface', 'bien.pieces', 'bien.meuble',
  'bail.reference', 'bail.type_libelle', 'bail.date_debut', 'bail.date_fin', 'bail.duree', 'bail.loyer',
  'bail.charges', 'bail.periodicite', 'bail.jour_echeance', 'bail.caution', 'bail.preavis_mois',
  'bail.revision_loyer', 'bail.repartition_charges', 'bail.occupants',
  'annexes', 'date_generation',
]);

const MOTIF = /\{\{\s*([a-z_]+(?:\.[a-z_]+)?)\s*\}\}/g;

/** Variables référencées par un texte de modèle. */
function variablesUtilisees(texte) {
  return [...new Set([...String(texte).matchAll(MOTIF)].map((m) => m[1]))];
}

/** Variables inconnues d'un modèle (vide = modèle valide). */
function variablesInconnues(texte) {
  return variablesUtilisees(texte).filter((v) => !VARIABLES.includes(v));
}

/** Remplace les variables ; une variable inconnue est une erreur (jamais laissée en clair). */
function rendre(texte, contexte) {
  const inconnues = variablesInconnues(texte);
  if (inconnues.length) {
    throw new ValidationError('Modèle invalide : variables inconnues', inconnues.map((v) => `{{${v}}}`), 'MODELE_INVALIDE');
  }
  return String(texte).replace(MOTIF, (_, cle) => String(contexte[cle] ?? ''));
}

function dureeLisible(debut, fin) {
  if (!fin) return 'une durée indéterminée';
  const mois = Math.round(ecartJours(debut, fin) / 30.4375);
  if (mois >= 12 && mois % 12 === 0) return `${mois / 12} an(s), jusqu'au ${formatFr(fin)}`;
  return `${mois} mois, jusqu'au ${formatFr(fin)}`;
}

/** Contexte de rendu à partir du bail (toutes les variables ont une valeur). */
async function contexte(lease, transaction) {
  const [apartment, tenant, owner, edl] = await Promise.all([
    Apartment.findByPk(lease.apartment_id, { include: [{ model: Building, as: 'building', paranoid: false }], paranoid: false, transaction }),
    Tenant.findByPk(lease.tenant_id, { paranoid: false, transaction }),
    Owner.findByPk(lease.owner_id, { transaction }),
    Inspection.findOne({ where: { lease_id: lease.id, type: 'entree', status: { [Op.ne]: 'remplace' } }, attributes: ['id', 'status', 'performed_at'], transaction }),
  ]);
  const b = apartment.building;
  const nonPrecise = 'non précisé(e)';
  return {
    'bailleur.nom': owner.company_name ? `${owner.company_name} (représentée par ${owner.display_name})` : owner.display_name,
    'bailleur.telephone': owner.phone || nonPrecise,
    'bailleur.email': owner.email || nonPrecise,
    'bailleur.adresse': [owner.address, owner.city].filter(Boolean).join(', ') || nonPrecise,
    'locataire.nom': `${tenant.first_name} ${tenant.last_name}`,
    'locataire.telephone': tenant.phone,
    'locataire.email': tenant.email || nonPrecise,
    'locataire.piece_identite': tenant.id_document_type
      ? `${TYPE_PIECE_IDENTITE[tenant.id_document_type]} n° ${tenant.id_document_number || nonPrecise}`
      : nonPrecise,
    'bien.immeuble': b.name,
    'bien.adresse': [b.address, b.district].filter(Boolean).join(', '),
    'bien.ville': b.city,
    'bien.numero': apartment.number,
    'bien.etage': apartment.floor === null || apartment.floor === undefined ? nonPrecise : String(apartment.floor),
    'bien.type': TYPE_APPARTEMENT[apartment.type] || apartment.type,
    'bien.surface': apartment.surface ? `${apartment.surface} m²` : nonPrecise,
    'bien.pieces': apartment.rooms_count ?? nonPrecise,
    'bien.meuble': apartment.is_furnished ? 'meublé' : 'non meublé',
    'bail.reference': lease.reference,
    'bail.type_libelle': (TYPE_BAIL[lease.lease_type] || '').toUpperCase(),
    'bail.date_debut': formatFr(lease.start_date),
    'bail.date_fin': lease.end_date ? formatFr(lease.end_date) : 'sans date de fin',
    'bail.duree': dureeLisible(lease.start_date, lease.end_date),
    'bail.loyer': formatFcfa(lease.rent_amount),
    'bail.charges': formatFcfa(lease.charges_amount),
    'bail.periodicite': (PERIODICITE[lease.periodicity] || lease.periodicity).toLowerCase(),
    'bail.jour_echeance': `${lease.due_day}`,
    'bail.caution': formatFcfa(lease.deposit_amount),
    'bail.preavis_mois': String(lease.notice_period_months),
    'bail.revision_loyer': lease.rent_revision_rule || 'Le loyer est révisable dans les conditions prévues par la réglementation en vigueur, par avenant signé des deux parties.',
    'bail.repartition_charges': 'Les charges communes (eau, électricité des parties communes, nettoyage, sécurité…) sont réparties entre les logements selon la méthode indiquée sur chaque facture, et communiquées au Locataire avec le détail du calcul.',
    'bail.occupants': String(lease.occupants_count),
    annexes: edl
      ? `État des lieux d'entrée (${edl.status === 'accepte' ? 'accepté par le Locataire' : 'soumis au Locataire'}), annexé au présent contrat.`
      : "État des lieux d'entrée, à établir contradictoirement lors de la remise des clés.",
    date_generation: formatFr(aujourdhui()),
  };
}

/** Version publiée du modèle pour ce type de bail. */
async function modelePublie(leaseType, transaction) {
  const modele = await LeaseTemplate.findOne({ where: { lease_type: leaseType, status: 'publie' }, transaction });
  if (!modele) {
    throw new ConflictError(
      `Aucun modèle de « ${TYPE_BAIL[leaseType]} » n'est publié. Le modèle doit être validé juridiquement puis publié par l'administrateur (§ 53.5).`,
      'MODELE_NON_PUBLIE'
    );
  }
  return modele;
}

/** PDF du contrat : texte du modèle, puis clauses particulières distinguées. */
async function pdfContrat({ titre, texte, clauses, reference, versionModele }) {
  return pdf.generer((doc, a) => {
    a.titre(titre);
    a.note(`Référence ${reference} — modèle version ${versionModele}`);
    doc.moveDown();
    a.paragraphe(texte, { align: 'left' });
    if (clauses) {
      a.sousTitre('CLAUSES PARTICULIÈRES (ajoutées par le Bailleur, hors modèle)');
      a.paragraphe(clauses, { align: 'left' });
    }
  }, { titre });
}

/** Prochain numéro de version de contrat pour un bail. */
async function prochaineVersion(leaseId, transaction) {
  const max = await LeaseDocument.max('version', { where: { lease_id: leaseId }, transaction });
  return (max || 0) + 1;
}

module.exports = {
  VARIABLES, variablesUtilisees, variablesInconnues, rendre, contexte, modelePublie, pdfContrat, prochaineVersion,
};
