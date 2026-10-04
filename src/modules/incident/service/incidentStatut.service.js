'use strict';

const { Tenant } = require('../../../models/index.js');
const { INCIDENT, verifierTransition } = require('../../../config/transitions.js');
const { STATUT_INCIDENT } = require('../../../config/enums.js');
const { notifier, destinataireLocataire } = require('../../notification/service/notification.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');

/**
 * Changement de statut d'un incident (§ 23) — point de passage UNIQUE, utilisé
 * par le module incident (analyse, rejet, résolution, travaux planifiés) et
 * par le module travaux (clôture ou annulation du chantier lié).
 *
 * Dans la transaction de l'appelant, l'incident déjà VERROUILLÉ :
 *   - transition vérifiée contre `config/transitions.js#INCIDENT` (409 sinon) ;
 *   - horodatages du workflow ;
 *   - audit `incident.changement_statut` ;
 *   - notification du locataire déclarant (§ 23 : il suit « Mes demandes »),
 *     en interne et par WhatsApp (modèle `incident_mis_a_jour`, § 54).
 *
 * Isolé dans ce fichier pour éviter une dépendance circulaire
 * incident.service ⇄ travaux.service.
 */

/** Libellé affiché au locataire (notification, WhatsApp). */
const libelleStatut = (statut) => STATUT_INCIDENT[statut] || statut;

/**
 * @param {import('sequelize').Transaction} t
 * @param {import('sequelize').Model} incident   verrouillé (lock UPDATE)
 * @param {string} vers
 * @param {object} [options]
 * @param {string|null} [options.motif]          motif de rejet
 * @param {string|null} [options.note]           note du propriétaire
 * @param {{ type?: string, titre?: string, corps?: string }} [options.notification]
 *        surcharge du message au locataire (ex. « travail terminé »)
 */
async function appliquerStatut(t, incident, vers, { motif = null, note = null, notification = {} } = {}) {
  const avant = incident.status;
  verifierTransition(INCIDENT, avant, vers, `L'incident ${incident.reference}`);

  const maintenant = new Date();
  const champs = { status: vers };
  if (note) champs.owner_note = note;
  if (vers === 'en_analyse' && !incident.analysed_at) champs.analysed_at = maintenant;
  if (vers === 'resolu') champs.resolved_at = maintenant;
  if (vers === 'rejete') Object.assign(champs, { rejected_at: maintenant, rejection_reason: motif });
  await incident.update(champs, { transaction: t });

  await journaliser({
    action: 'incident.changement_statut', entityType: 'incident', entityId: incident.id, ownerId: incident.owner_id,
    details: { reference: incident.reference, avant, apres: vers, ...(motif ? { motif } : {}) },
  }, t);

  if (incident.tenant_id) {
    const tenant = await Tenant.findByPk(incident.tenant_id, { attributes: ['id', 'user_id'], paranoid: false, transaction: t });
    if (tenant) {
      const libelle = libelleStatut(vers);
      await notifier(t, {
        destinataires: [destinataireLocataire(tenant)],
        ownerId: incident.owner_id,
        type: notification.type || 'incident',
        titre: notification.titre || `Votre demande ${incident.reference} : ${libelle}`,
        corps: notification.corps || (vers === 'rejete' && motif
          ? `« ${incident.title} » a été rejetée : ${motif}`
          : `« ${incident.title} » est désormais au statut « ${libelle} ».`),
        donnees: { incident_id: incident.id, status: vers },
        whatsapp: { evenement: 'incident_mis_a_jour', parametres: [incident.reference, libelle] },
      });
    }
  }
  return incident;
}

/** La transition est-elle permise depuis le statut actuel ? (sans lever d'erreur) */
const transitionPermise = (incident, vers) => (INCIDENT[incident.status] || []).includes(vers);

module.exports = { appliquerStatut, transitionPermise, libelleStatut };
