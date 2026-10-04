'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { aujourdhui, formatFr } = require('../../../utils/dates.js');
const { formatFcfa } = require('../../../utils/montants.js');
const { DEFAUTS_PROPRIETAIRE } = require('../../../config/parametres.js');
const { notifier, destinatairesProprietaire } = require('../../notification/service/notification.service.js');

/**
 * Relances automatiques (§ 14, § 54.2).
 *
 *   J-3 (avant échéance)  « Votre loyer arrive bientôt à échéance. »
 *   J0                    « Votre loyer est aujourd'hui exigible. »
 *   J+3, J+7, J+15        relances de retard, ton PROGRESSIF (niveaux 1 à 3)
 *
 * Délais configurables par propriétaire (`reminder_offsets`). Canaux : push
 * puis WhatsApp selon l'ordre de repli (notification.service).
 *
 * UNE relance par échéance et par délai, garantie par la base : la ligne
 * `rent_reminders` est RÉSERVÉE (INSERT … ON CONFLICT DO NOTHING RETURNING)
 * avant l'envoi. Un redémarrage, un double déclenchement du job ou deux hôtes
 * ne produisent jamais deux relances identiques.
 */

/** Événement WhatsApp et message selon le délai (fonction pure). */
function gabarit(decalage, rangRetard) {
  if (decalage < 0) return { evenement: 'rappel_avant_echeance', titre: 'Loyer bientôt exigible' };
  if (decalage === 0) return { evenement: 'echeance_jour', titre: "Loyer exigible aujourd'hui" };
  const niveau = Math.min(3, rangRetard);
  return { evenement: `retard_niveau_${niveau}`, titre: niveau === 3 ? 'Dernier rappel : loyer impayé' : 'Loyer en retard' };
}

function corps(decalage, e) {
  const reste = formatFcfa(e.amount_due - e.amount_paid);
  if (decalage < 0) return `Votre ${e.label.toLowerCase()} (${reste}) arrive à échéance le ${formatFr(e.due_date)}.`;
  if (decalage === 0) return `Votre ${e.label.toLowerCase()} (${reste}) est exigible aujourd'hui.`;
  return `Votre ${e.label.toLowerCase()} présente un retard de ${decalage} jours. Reste dû : ${reste}.`;
}

/** Taille d'un lot de candidates (réglable : `RELANCES_TAILLE_LOT`). */
const TAILLE_LOT_DEFAUT = 1000;
const tailleLotConfiguree = () => {
  const n = Number.parseInt(process.env.RELANCES_TAILLE_LOT, 10);
  return Number.isInteger(n) && n > 0 ? n : TAILLE_LOT_DEFAUT;
};

/**
 * Un lot de candidates : échéances ouvertes dont l'écart au jour figure dans
 * les délais du propriétaire et qui n'ont pas encore reçu la relance
 * correspondante. Pagination par CLÉ (id croissant, après le dernier id du
 * lot précédent) : chaque échéance est vue une fois par passage, sans OFFSET.
 */
function lotDeCandidates(jour, apres, taille) {
  return sequelize.query(`
    SELECT rs.id, rs.owner_id, rs.tenant_id, rs.lease_id, rs.label, rs.due_date, rs.amount_due, rs.amount_paid,
           (CAST(:jour AS date) - rs.due_date) AS decalage,
           COALESCE(o.settings->'reminder_offsets', CAST(:defauts AS jsonb)) AS delais,
           tn.user_id, tn.first_name, tn.last_name
      FROM rent_schedules rs
      JOIN owners o ON o.id = rs.owner_id AND o.status = 'actif'
      JOIN leases l ON l.id = rs.lease_id AND l.status = 'actif'
      JOIN tenants tn ON tn.id = rs.tenant_id
     WHERE rs.status IN ('a_venir', 'a_payer', 'partiellement_paye', 'en_retard')
       AND rs.amount_paid < rs.amount_due
       AND rs.due_date BETWEEN CAST(:jour AS date) - 90 AND CAST(:jour AS date) + 30
       AND COALESCE(o.settings->'reminder_offsets', CAST(:defauts AS jsonb)) @> to_jsonb(CAST(:jour AS date) - rs.due_date)
       AND NOT EXISTS (SELECT 1 FROM rent_reminders r WHERE r.rent_schedule_id = rs.id AND r.offset_days = CAST(:jour AS date) - rs.due_date)
       AND (CAST(:apres AS uuid) IS NULL OR rs.id > CAST(:apres AS uuid))
     ORDER BY rs.id
     LIMIT :taille`,
  {
    replacements: { jour, apres, taille, defauts: JSON.stringify(DEFAUTS_PROPRIETAIRE.reminder_offsets) },
    type: QueryTypes.SELECT,
  });
}

/**
 * Envoie les relances du jour, par lots ordonnés jusqu'à épuisement (un
 * `LIMIT` sans reprise laissait sans relance les échéances au-delà du premier
 * lot). Retourne le nombre de relances envoyées.
 * @param {string} [jour]
 * @param {{ tailleLot?: number }} [options]
 */
async function envoyerRelances(jour = aujourdhui(), { tailleLot } = {}) {
  // Une taille nulle ou invalide bouclerait sans fin : repli sur la configuration.
  const taille = Number.isInteger(tailleLot) && tailleLot > 0 ? tailleLot : tailleLotConfiguree();
  let envoyees = 0;
  let apres = null;
  for (;;) {
    const candidates = await lotDeCandidates(jour, apres, taille);
    for (const e of candidates) {
      if (await envoyerRelance(e)) envoyees += 1;
    }
    if (candidates.length < taille) break;
    apres = candidates[candidates.length - 1].id;
  }
  return envoyees;
}

/**
 * Relance d'UNE échéance : réservation de la ligne `rent_reminders` puis
 * notifications, dans une transaction. Retourne false si une autre exécution
 * l'a déjà réservée (double déclenchement, deux hôtes).
 */
async function envoyerRelance(e) {
  const decalage = Number(e.decalage);
  const retards = (e.delais || []).filter((d) => d > 0).sort((a, b) => a - b);
  const rangRetard = retards.indexOf(decalage) + 1;
  const g = gabarit(decalage, rangRetard);

  return sequelize.transaction(async (t) => {
    const [reservee] = await sequelize.query(
      `INSERT INTO rent_reminders (rent_schedule_id, offset_days, channels) VALUES (:id, :decalage, ARRAY['in_app']::text[])
       ON CONFLICT (rent_schedule_id, offset_days) DO NOTHING RETURNING id`,
      { replacements: { id: e.id, decalage }, type: QueryTypes.SELECT, transaction: t }
    );
    if (!reservee) return false;

    await notifier(t, {
      destinataires: [{ userId: e.user_id, tenantId: e.tenant_id }],
      ownerId: e.owner_id,
      type: decalage > 0 ? 'retard_loyer' : 'echeance',
      titre: g.titre,
      corps: corps(decalage, e),
      donnees: { rent_schedule_id: e.id, lease_id: e.lease_id },
      whatsapp: {
        evenement: g.evenement,
        parametres: decalage > 0
          ? [e.label.toLowerCase(), String(decalage), formatFcfa(e.amount_due - e.amount_paid)]
          : [e.label.toLowerCase(), formatFcfa(e.amount_due - e.amount_paid), formatFr(e.due_date)],
      },
    });

    // § 27 « retard de loyer » : le propriétaire est prévenu au PREMIER retard.
    if (decalage > 0 && rangRetard === 1) {
      await notifier(t, {
        destinataires: await destinatairesProprietaire(e.owner_id, t),
        ownerId: e.owner_id,
        type: 'retard_loyer',
        titre: 'Loyer en retard',
        corps: `${e.first_name} ${e.last_name} : ${e.label.toLowerCase()} impayé depuis ${decalage} jours (${formatFcfa(e.amount_due - e.amount_paid)}).`,
        donnees: { rent_schedule_id: e.id, lease_id: e.lease_id },
      });
    }
    return true;
  });
}

module.exports = { envoyerRelances, gabarit, corps, TAILLE_LOT_DEFAUT };
