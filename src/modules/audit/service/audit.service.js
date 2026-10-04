'use strict';

const { AuditLog } = require('../../../models/index.js');
const { contexteCourant } = require('../../../utils/requestContext.js');
const { masquerObjet } = require('../../../utils/logger.js');

/**
 * Journal d'audit (§ 40) : « qui a fait quoi, quand et sur quelle donnée ».
 *
 * Écrit dans la MÊME transaction que l'action journalisée : une action
 * annulée (rollback) ne laisse pas de ligne d'audit mensongère, et une action
 * validée a TOUJOURS sa ligne — contrairement à une écriture « best-effort »
 * après coup, qui peut se perdre.
 *
 * L'auteur, l'adresse IP, l'agent et l'identifiant de requête sont lus dans le
 * contexte de la requête (requestId.middleware.js) : les services n'ont pas à
 * les transporter. Les détails passent par le même masquage que les journaux
 * techniques (aucun mot de passe, jeton ou secret ne peut y être écrit).
 *
 * Actions normalisées (§ 40) : creation, modification, suppression, paiement,
 * remboursement, changement_statut, ajout_document, modification_loyer — sous
 * la forme `<ressource>.<action>` (ex. `depense.creation`).
 */

/**
 * @param {object} entree
 * @param {string} entree.action
 * @param {string} [entree.entityType]
 * @param {string} [entree.entityId]
 * @param {string|null} [entree.ownerId]
 * @param {object} [entree.details]
 * @param {{ id?: string, role_code?: string }} [entree.acteur] — défaut : utilisateur de la requête
 * @param {import('sequelize').Transaction} [transaction]
 */
async function journaliser({ action, entityType = null, entityId = null, ownerId = null, details = null, acteur = null }, transaction) {
  const contexte = contexteCourant() || {};
  await AuditLog.create({
    user_id: acteur?.id ?? contexte.utilisateurId ?? null,
    actor_role: acteur?.role_code ?? contexte.utilisateurRole ?? (acteur ? null : 'systeme'),
    owner_id: ownerId ?? contexte.ownerId ?? null,
    action,
    entity_type: entityType,
    entity_id: entityId ? String(entityId) : null,
    details: details ? masquerObjet(details, 3) : null,
    ip: contexte.ip ?? null,
    user_agent: contexte.userAgent ?? null,
    request_id: contexte.requestId ?? null,
  }, { transaction });
}

/**
 * Différence lisible entre deux états (champs modifiés seulement) — pour les
 * actions « modification ».
 * @param {object} avant
 * @param {object} apres
 * @param {string[]} champs
 */
function difference(avant, apres, champs) {
  const diff = {};
  for (const champ of champs) {
    if (!(champ in apres)) continue;
    const a = avant[champ] ?? null;
    const b = apres[champ] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) diff[champ] = { avant: a, apres: b };
  }
  return diff;
}

module.exports = { journaliser, difference };
