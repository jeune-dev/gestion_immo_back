'use strict';

/**
 * Fragments SQL des INDICATEURS FINANCIERS, partagés par le tableau de bord
 * (§ 6, § 48) et les rapports (§ 26) : un même mot (« revenus », « impayés »)
 * doit donner le même chiffre sur tous les écrans.
 *
 * Définitions retenues :
 *   - revenus d'une période = allocations VIVANTES (non contrepassées) des
 *     paiements VALIDES dont `paid_on` est dans la période — loyers
 *     (allocation sur une échéance) et charges récupérées (allocation sur une
 *     charge) — plus les « autres revenus » de caisse non annulés (§ 21).
 *     La caution n'est JAMAIS un revenu (§ 55.4) : ni `deposits` ni les
 *     mouvements `is_deposit` n'entrent ici ;
 *   - dépenses = dépenses au statut `valide` dont `spent_on` est dans la période ;
 *   - impayés (état courant) = reste dû des échéances `en_retard`, plus celui
 *     des échéances partiellement payées déjà échues.
 *
 * Tous les fragments sont des CONSTANTES du code : aucune valeur venant du
 * client n'y est concaténée, elles passent par les `replacements` nommés
 * (:ownerId, :buildingId, :du, :au, :jour, :fuseau).
 *
 * Chaque sous-requête filtre `owner_id = :ownerId` (isolation § 32, § 45 :
 * « aucune fuite de données entre propriétaires ») et, si demandé, l'immeuble.
 */

/**
 * Filtre optionnel sur l'immeuble. `colonne` est un identifiant écrit en dur
 * dans le code appelant, jamais une donnée client.
 * @param {string} colonne
 */
const IMMEUBLE = (colonne) => `(CAST(:buildingId AS uuid) IS NULL OR ${colonne} = CAST(:buildingId AS uuid))`;

/**
 * Bornes horaires d'une date calendaire dans le fuseau de l'application : les
 * colonnes `created_at` / `completed_at` sont des timestamptz, comparées par
 * intervalle (et non par `::date`) pour rester indexables.
 * @param {string} parametre  nom du replacement, ex. ':du'
 */
const DEBUT_JOUR = (parametre) => `(CAST(${parametre} AS date)::timestamp AT TIME ZONE :fuseau)`;
const FIN_JOUR = (parametre) => `((CAST(${parametre} AS date) + 1)::timestamp AT TIME ZONE :fuseau)`;

/** Échéance impayée à ce jour (alias `rs`). */
const ECHEANCE_IMPAYEE = `(rs.status = 'en_retard' OR (rs.status = 'partiellement_paye' AND rs.due_date < CAST(:jour AS date)))`;

/**
 * Allocations encaissées sur [:du, :au] (une ligne par allocation), avec
 * l'appartement et l'immeuble du paiement. Chemin d'index :
 * rent_payments_owner_idx (owner_id, paid_on) → payment_allocations_payment_idx.
 */
const ENCAISSEMENTS = `
  SELECT rp.paid_on, rp.apartment_id, a.building_id, pa.amount,
         (pa.rent_schedule_id IS NOT NULL) AS est_loyer
    FROM payment_allocations pa
    JOIN rent_payments rp ON rp.id = pa.rent_payment_id
    JOIN apartments a ON a.id = rp.apartment_id
   WHERE rp.owner_id = :ownerId AND pa.owner_id = :ownerId
     AND rp.status = 'valide' AND pa.reversed_at IS NULL
     AND rp.paid_on BETWEEN :du AND :au
     AND ${IMMEUBLE('a.building_id')}`;

/** « Autres revenus » de caisse sur [:du, :au] (§ 21) — jamais la caution. */
const AUTRES_REVENUS = `
  SELECT cm.occurred_on, cm.building_id, cm.apartment_id, cm.amount
    FROM cash_movements cm
   WHERE cm.owner_id = :ownerId AND cm.category = 'autre_revenu' AND cm.is_deposit = false
     AND cm.cancelled_at IS NULL
     AND cm.occurred_on BETWEEN :du AND :au
     AND ${IMMEUBLE('cm.building_id')}`;

/** Dépenses valides sur [:du, :au] (§ 20). */
const DEPENSES = `
  SELECT e.id, e.spent_on, e.building_id, e.apartment_id, e.category_id, e.contractor_id, e.work_order_id, e.amount
    FROM expenses e
   WHERE e.owner_id = :ownerId AND e.status = 'valide'
     AND e.spent_on BETWEEN :du AND :au
     AND ${IMMEUBLE('e.building_id')}`;

/**
 * Impayés À LA DATE :au (rapports § 26) : pour chaque échéance échue au plus
 * tard à :au, reste dû = montant − paiements valides datés d'au plus tard :au.
 * Recalculé depuis les allocations (et non `amount_paid`, qui reflète
 * aujourd'hui) pour qu'un rapport sur une période passée ne change pas quand
 * le locataire régularise ensuite. Deux agrégats joints par hachage, sans
 * sous-requête corrélée par échéance.
 */
const IMPAYES_A_DATE = `
  WITH paye_a_date AS (
    SELECT pa.rent_schedule_id, sum(pa.amount) AS paye
      FROM payment_allocations pa
      JOIN rent_payments rp ON rp.id = pa.rent_payment_id
     WHERE pa.owner_id = :ownerId AND rp.owner_id = :ownerId
       AND pa.rent_schedule_id IS NOT NULL AND pa.reversed_at IS NULL
       AND rp.status = 'valide' AND rp.paid_on <= :au
     GROUP BY pa.rent_schedule_id
  )
  SELECT rs.id, rs.tenant_id, rs.apartment_id, a.building_id, rs.due_date,
         rs.amount_due - COALESCE(p.paye, 0) AS reste
    FROM rent_schedules rs
    JOIN apartments a ON a.id = rs.apartment_id
    LEFT JOIN paye_a_date p ON p.rent_schedule_id = rs.id
   WHERE rs.owner_id = :ownerId AND rs.status <> 'annule' AND rs.due_date <= :au
     AND rs.amount_due - COALESCE(p.paye, 0) > 0
     AND ${IMMEUBLE('a.building_id')}`;

/**
 * Jours d'occupation par appartement sur [:du, :au] : chevauchement des baux
 * ayant réellement couru (actif, terminé, clos) avec la période. Un bail actif
 * court jusqu'à :au ; un bail terminé jusqu'à sa date de sortie.
 */
const OCCUPATION = `
  SELECT l.apartment_id,
         sum(GREATEST(0,
           LEAST(COALESCE(l.ended_on, CAST(:au AS date)), CAST(:au AS date))
           - GREATEST(l.start_date, CAST(:du AS date)) + 1)) AS jours
    FROM leases l
   WHERE l.owner_id = :ownerId AND l.status IN ('actif', 'termine', 'clos')
     AND l.start_date <= :au AND (l.ended_on IS NULL OR l.ended_on >= :du)
   GROUP BY l.apartment_id`;

/** Dépenses de [:du, :au] par catégorie (§ 20, § 6 « dépenses par catégorie »). */
const DEPENSES_PAR_CATEGORIE = `
  SELECT c.id AS category_id, c.code, c.name, c.cash_group, sum(x.amount) AS total, count(*) AS nombre
    FROM (${DEPENSES}) x
    JOIN expense_categories c ON c.id = x.category_id
   GROUP BY c.id
   ORDER BY total DESC, c.name, c.id`;

/** Pourcentage arrondi au dixième (0 si le dénominateur est nul). */
function pourcentage(numerateur, denominateur) {
  if (!denominateur) return 0;
  return Math.round((1000 * numerateur) / denominateur) / 10;
}

module.exports = {
  IMMEUBLE, DEBUT_JOUR, FIN_JOUR, ECHEANCE_IMPAYEE,
  ENCAISSEMENTS, AUTRES_REVENUS, DEPENSES, DEPENSES_PAR_CATEGORIE, IMPAYES_A_DATE, OCCUPATION,
  pourcentage,
};
