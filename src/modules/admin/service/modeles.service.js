'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { LeaseTemplate, WhatsappTemplate } = require('../../../models/index.js');
const { NotFoundError, ConflictError, ValidationError } = require('../../../errors/AppError.js');
const { VARIABLES, variablesInconnues } = require('../../bail/service/modeleBail.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Modèles de bail versionnés (§ 53.4) et modèles WhatsApp (§ 54.3).
 *
 * Cycle d'une version de bail : brouillon → publié → archivé.
 *   - seul un BROUILLON se modifie ; une version publiée ou archivée est
 *     IMMUABLE (409) : les baux déjà générés conservent leur texte figé
 *     (`lease_documents.content`), et le numéro de version qu'ils citent doit
 *     désigner pour toujours le même texte ;
 *   - publier une version archive, dans la MÊME transaction, la version publiée
 *     du même type (index unique partiel : une seule version publiée par type) ;
 *   - le Super Admin publie sans mise à jour de l'application (§ 53.4), après
 *     validation juridique (§ 53.5).
 */

function verifierVariables(texte) {
  const inconnues = variablesInconnues(texte);
  if (inconnues.length) {
    throw new ValidationError(
      'Modèle invalide : variables inconnues',
      inconnues.map((v) => `{{${v}}} n'est pas une variable disponible`),
      'MODELE_INVALIDE'
    );
  }
}

async function listerBaux(filtres) {
  const where = {};
  if (filtres.lease_type) where.lease_type = filtres.lease_type;
  if (filtres.status) where.status = filtres.status;
  return LeaseTemplate.findAll({
    where,
    // Le texte complet n'est renvoyé qu'au détail : une liste de versions
    // n'a pas à transporter des dizaines de pages de contrat.
    attributes: { exclude: ['body'] },
    order: [['lease_type', 'ASC'], ['version', 'DESC']],
  });
}

const variables = () => VARIABLES;

async function chargerBail(id, options = {}) {
  const modele = await LeaseTemplate.findByPk(id, options);
  if (!modele) throw new NotFoundError('Modèle de bail introuvable');
  return modele;
}

const detailBail = (id) => chargerBail(id);

/** Nouvelle version (brouillon) : numéro = dernier du type + 1. */
async function creerBail(admin, { lease_type: type, title, body, legal_notes: notes = null }) {
  verifierVariables(body);
  return sequelize.transaction(async (t) => {
    // Verrou consultatif par type : deux créations simultanées ne calculent
    // jamais le même numéro de version.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:cle))', {
      replacements: { cle: `lease_templates:${type}` }, type: QueryTypes.SELECT, transaction: t,
    });
    const max = await LeaseTemplate.max('version', { where: { lease_type: type }, transaction: t });
    const modele = await LeaseTemplate.create({
      lease_type: type, version: (max || 0) + 1, title, body, legal_notes: notes, status: 'brouillon', created_by: admin.id,
    }, { transaction: t });
    await journaliser({
      action: 'modele_bail.creation', entityType: 'lease_template', entityId: modele.id,
      details: { lease_type: type, version: modele.version, title },
    }, t);
    return modele;
  });
}

function exigerBrouillon(modele) {
  if (modele.status !== 'brouillon') {
    throw new ConflictError(
      `La version ${modele.version} est ${modele.status === 'publie' ? 'publiée' : 'archivée'} : elle ne peut plus être modifiée. Créez une nouvelle version.`,
      'MODELE_IMMUABLE'
    );
  }
}

const CHAMPS_BAIL = ['title', 'body', 'legal_notes'];

async function modifierBail(id, donnees) {
  if (donnees.body !== undefined) verifierVariables(donnees.body);
  return sequelize.transaction(async (t) => {
    const modele = await chargerBail(id, { transaction: t, lock: t.LOCK.UPDATE });
    exigerBrouillon(modele);
    const avant = modele.toJSON();
    await modele.update(donnees, { transaction: t, fields: CHAMPS_BAIL });
    const diff = difference(avant, donnees, ['title', 'legal_notes']);
    if (donnees.body !== undefined && donnees.body !== avant.body) diff.body = 'modifié';
    await journaliser({ action: 'modele_bail.modification', entityType: 'lease_template', entityId: id, details: diff }, t);
    return modele;
  });
}

async function publierBail(admin, id) {
  return sequelize.transaction(async (t) => {
    const modele = await chargerBail(id, { transaction: t, lock: t.LOCK.UPDATE });
    exigerBrouillon(modele);
    verifierVariables(modele.body);
    // Archivage d'abord : l'index unique partiel n'admet qu'une version
    // publiée par type à tout instant de la transaction.
    const [, archivees] = await LeaseTemplate.update(
      { status: 'archive' },
      { where: { lease_type: modele.lease_type, status: 'publie' }, returning: ['id', 'version'], transaction: t }
    );
    await modele.update({ status: 'publie', published_at: new Date(), published_by: admin.id }, { transaction: t });
    await journaliser({
      action: 'modele_bail.changement_statut', entityType: 'lease_template', entityId: id,
      details: {
        lease_type: modele.lease_type, version: modele.version, a: 'publie',
        version_archivee: archivees?.[0]?.version ?? null,
      },
    }, t);
    return modele;
  });
}

/**
 * Archivage manuel (retrait d'un brouillon abandonné ou d'une version
 * publiée devenue non conforme). Sans version publiée, la génération de bail
 * de ce type est refusée (MODELE_NON_PUBLIE) jusqu'à la publication suivante.
 */
async function archiverBail(id) {
  return sequelize.transaction(async (t) => {
    const modele = await chargerBail(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (modele.status === 'archive') throw new ConflictError('Cette version est déjà archivée.', 'MODELE_IMMUABLE');
    const avant = modele.status;
    await modele.update({ status: 'archive' }, { transaction: t });
    await journaliser({
      action: 'modele_bail.changement_statut', entityType: 'lease_template', entityId: id,
      details: { lease_type: modele.lease_type, version: modele.version, de: avant, a: 'archive' },
    }, t);
    return modele;
  });
}

// ── Modèles WhatsApp ───────────────────────────────────────────────────────

async function listerWhatsapp() {
  return WhatsappTemplate.findAll({ order: [['event_code', 'ASC']] });
}

const CHAMPS_WHATSAPP = ['meta_template_name', 'language_code', 'body_preview', 'variables', 'is_active'];

/**
 * Mise en correspondance avec le modèle APPROUVÉ par Meta (§ 54.3) : même
 * nom, même langue, même nombre de paramètres. Les paramètres positionnels
 * `{{1}}…{{n}}` de l'aperçu doivent correspondre exactement à la liste des
 * variables transmises à l'envoi — sinon Meta rejette chaque message.
 */
async function modifierWhatsapp(id, donnees) {
  return sequelize.transaction(async (t) => {
    const modele = await WhatsappTemplate.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!modele) throw new NotFoundError('Modèle WhatsApp introuvable');
    const apercu = donnees.body_preview ?? modele.body_preview;
    const vars = donnees.variables ?? modele.variables;
    const positions = [...new Set([...apercu.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    const attendues = vars.map((_, i) => i + 1);
    if (positions.length !== attendues.length || positions.some((p, i) => p !== attendues[i])) {
      throw new ValidationError(
        'Données invalides',
        [`L'aperçu doit utiliser exactement les paramètres {{1}} à {{${vars.length}}} (un par variable).`],
        'MODELE_INVALIDE'
      );
    }
    const avant = modele.toJSON();
    await modele.update(donnees, { transaction: t, fields: CHAMPS_WHATSAPP });
    await journaliser({
      action: 'modele_whatsapp.modification', entityType: 'whatsapp_template', entityId: id,
      details: { event_code: modele.event_code, ...difference(avant, donnees, CHAMPS_WHATSAPP) },
    }, t);
    return modele;
  });
}

module.exports = {
  listerBaux, variables, detailBail, creerBail, modifierBail, publierBail, archiverBail,
  listerWhatsapp, modifierWhatsapp,
};
