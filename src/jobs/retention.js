'use strict';

const sequelize = require('../config/db.js');
const storage = require('../infrastructure/storage.service.js');
const { journaliser } = require('../modules/audit/service/audit.service.js');
const logger = require('../utils/logger.js');

/**
 * Durées de conservation (constat M4 de l'audit — loi 2008-12, principe de
 * limitation de la conservation). Politique documentée dans docs/RETENTION.md :
 *
 *   - pièces d'identité des locataires (numéro chiffré + fichiers
 *     « piece_identite ») : supprimées 12 mois après la fin du DERNIER bail
 *     du locataire chez ce bailleur (ou 12 mois après la création de la fiche
 *     s'il n'a jamais eu de bail) — délai de contestation de fin de bail et
 *     de restitution de caution ;
 *   - pièces comptables (loyers, quittances, caisse, cautions) : conservées
 *     10 ans (obligation comptable, Acte uniforme OHADA) — AUCUNE suppression
 *     automatique : la plateforme a moins de 10 ans d'historique ;
 *   - comptes supprimés à la demande : anonymisés immédiatement
 *     (modules/compte/service/suppression.service.js).
 *
 * Les fichiers sont effacés du stockage APRÈS la validation de la transaction
 * (un échec de stockage ne laisse jamais la base incohérente).
 */

const MOIS_APRES_BAIL = 12;
const TAILLE_LOT = 200;

const SELECTION = `
  SELECT t.id, t.owner_id FROM tenants t
   WHERE t.id_document_purged_at IS NULL
     AND (t.id_document_number IS NOT NULL OR EXISTS (
           SELECT 1 FROM documents d WHERE d.category = 'piece_identite' AND d.deleted_at IS NULL
              AND (d.tenant_id = t.id OR (d.entity_type = 'tenant' AND d.entity_id = t.id))))
     AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.tenant_id = t.id AND l.status IN ('brouillon', 'actif'))
     AND COALESCE(
           (SELECT max(COALESCE(l.ended_on, l.end_date, l.closed_at::date, l.cancelled_at::date, l.updated_at::date))
              FROM leases l WHERE l.tenant_id = t.id),
           t.created_at::date
         ) < (now() - make_interval(months => :mois))::date
   ORDER BY t.id
   LIMIT :taille`;

/**
 * @returns {Promise<{ locataires: number, fichiers: number }>}
 */
async function purgerPiecesIdentite({ mois = MOIS_APRES_BAIL, taille = TAILLE_LOT } = {}) {
  const [cibles] = await sequelize.query(SELECTION, { replacements: { mois, taille } });
  let fichiers = 0;
  for (const { id, owner_id: ownerId } of cibles) {
    const cles = await sequelize.transaction(async (t) => {
      const [docs] = await sequelize.query(
        `UPDATE documents SET deleted_at = now()
          WHERE category = 'piece_identite' AND deleted_at IS NULL
            AND (tenant_id = :id OR (entity_type = 'tenant' AND entity_id = :id))
          RETURNING storage_key, thumbnail_key`,
        { replacements: { id }, transaction: t }
      );
      await sequelize.query(
        'UPDATE tenants SET id_document_number = NULL, id_document_purged_at = now(), updated_at = now() WHERE id = :id',
        { replacements: { id }, transaction: t }
      );
      await journaliser({
        action: 'locataire.purge_piece_identite', entityType: 'tenant', entityId: id, ownerId,
        details: { fichiers: docs.length, regle: `${mois} mois après la fin du dernier bail` },
      }, t);
      return docs.flatMap((d) => [d.storage_key, d.thumbnail_key]).filter(Boolean);
    });
    for (const cle of cles) {
      try {
        await storage.supprimer(cle);
        fichiers += 1;
      } catch (err) {
        logger.warn('[retention] Fichier non supprimé du stockage', { error: err.message });
      }
    }
  }
  return { locataires: cibles.length, fichiers };
}

module.exports = { purgerPiecesIdentite, MOIS_APRES_BAIL };
