'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { Building } = require('../../../models/index.js');
const { verifierReference } = require('../../../utils/acces.js');
const cache = require('../../../utils/cache.js');
const {
  FUSEAU, aujourdhui, ajouterMois, debutMois, finMois,
} = require('../../../utils/dates.js');
const {
  IMMEUBLE, DEBUT_JOUR, FIN_JOUR, ECHEANCE_IMPAYEE, ENCAISSEMENTS, AUTRES_REVENUS, DEPENSES, DEPENSES_PAR_CATEGORIE,
  pourcentage,
} = require('../../rapport/service/indicateurs.js');

/**
 * Tableau de bord du propriétaire (§ 6) et réponses aux sept questions du
 * principe produit (§ 48) : combien ai-je encaissé, qui n'a pas payé, combien
 * ai-je dépensé, quel appartement coûte le plus cher, quelle facture répartir,
 * quels travaux sont en cours, que s'est-il passé aujourd'hui.
 *
 * Performance (§ 37, § 45 « écrans principaux rapides avec plusieurs milliers
 * de données ») : QUATRE requêtes agrégées lancées en parallèle, quel que soit
 * le volume ; résultat mis en cache 45 s par propriétaire et paramètres
 * (écran d'accueil ouvert à chaque session), calcul « à vol unique » pour
 * qu'une rafale d'ouvertures simultanées ne lance qu'un seul calcul.
 */

const TTL_S = 45;
const STATUTS_TRAVAUX_EN_COURS = "('valide', 'artisan_assigne', 'en_cours')";

/**
 * Cache « lecture, sinon calcul unique puis écriture ». La clé inclut le jour
 * (les impayés et « aujourd'hui » en dépendent) et l'immeuble filtré.
 */
async function avecCache(cle, calcul) {
  const enCache = await cache.lire(cle);
  if (enCache) return enCache;
  return cache.volUnique(cle, async () => {
    const resultat = await calcul();
    await cache.ecrire(cle, resultat, TTL_S);
    return resultat;
  });
}

/**
 * Chiffres clés : une seule ligne, sous-requêtes indépendantes.
 *   - loyers du mois (par date d'échéance) et impayés courants sont calculés
 *     en UN parcours de rent_schedules_owner_idx (owner_id, status, due_date) ;
 *   - un paiement non identifié (« à rapprocher ») n'a pas encore de bail : il
 *     reste compté quel que soit l'immeuble filtré, car il doit être traité.
 */
const SQL_CHIFFRES = `
  SELECT
    (SELECT count(*) FROM buildings b
      WHERE b.owner_id = :ownerId AND b.deleted_at IS NULL AND ${IMMEUBLE('b.id')}) AS immeubles,
    ap.appartements, ap.occupes, ap.disponibles, ap.en_travaux, ap.indisponibles,
    lo.a_recevoir, lo.encaisses, lo.impayes,
    en.revenus_loyers, en.revenus_charges,
    (SELECT COALESCE(sum(amount), 0) FROM (${AUTRES_REVENUS}) ar) AS revenus_autres,
    (SELECT COALESCE(sum(amount), 0) FROM (${DEPENSES}) dep) AS depenses,
    (SELECT count(*) FROM work_orders w
      WHERE w.owner_id = :ownerId AND w.status IN ${STATUTS_TRAVAUX_EN_COURS} AND ${IMMEUBLE('w.building_id')}) AS travaux_en_cours,
    (SELECT COALESCE(sum(d.amount_received - d.amount_withheld - d.amount_refunded), 0)
       FROM deposits d
       JOIN leases l ON l.id = d.lease_id
       JOIN apartments a ON a.id = l.apartment_id
      WHERE d.owner_id = :ownerId AND d.status <> 'restituee' AND ${IMMEUBLE('a.building_id')}) AS cautions_detenues,
    (SELECT count(*) FROM payment_transactions pt
       JOIN leases l ON l.id = pt.lease_id
       JOIN apartments a ON a.id = l.apartment_id
      WHERE pt.owner_id = :ownerId AND pt.mode = 'preuve' AND pt.status = 'en_attente'
        AND ${IMMEUBLE('a.building_id')}) AS preuves_a_valider,
    (SELECT count(*) FROM reconciliation_entries re
       LEFT JOIN leases l ON l.id = re.lease_id
       LEFT JOIN apartments a ON a.id = l.apartment_id
      WHERE re.owner_id = :ownerId AND re.status = 'en_attente'
        AND (re.lease_id IS NULL OR ${IMMEUBLE('a.building_id')})) AS a_rapprocher,
    (SELECT count(*) FROM charge_invoices ci
      WHERE ci.owner_id = :ownerId AND ci.status = 'brouillon' AND ${IMMEUBLE('ci.building_id')}) AS factures_a_repartir,
    (SELECT count(*) FROM incidents i
      WHERE i.owner_id = :ownerId AND i.status IN ('signale', 'en_analyse') AND ${IMMEUBLE('i.building_id')}) AS incidents_ouverts
  FROM
    (SELECT count(*) AS appartements,
            count(*) FILTER (WHERE a.status = 'occupe') AS occupes,
            count(*) FILTER (WHERE a.status = 'disponible') AS disponibles,
            count(*) FILTER (WHERE a.status = 'en_travaux') AS en_travaux,
            count(*) FILTER (WHERE a.status = 'indisponible') AS indisponibles
       FROM apartments a
      WHERE a.owner_id = :ownerId AND a.deleted_at IS NULL AND ${IMMEUBLE('a.building_id')}) ap,
    (SELECT COALESCE(sum(rs.amount_due) FILTER (WHERE rs.due_date BETWEEN :du AND :au), 0) AS a_recevoir,
            COALESCE(sum(rs.amount_paid) FILTER (WHERE rs.due_date BETWEEN :du AND :au), 0) AS encaisses,
            COALESCE(sum(rs.amount_due - rs.amount_paid) FILTER (WHERE ${ECHEANCE_IMPAYEE}), 0) AS impayes
       FROM rent_schedules rs
       JOIN apartments a ON a.id = rs.apartment_id
      WHERE rs.owner_id = :ownerId AND rs.status <> 'annule'
        AND (rs.due_date BETWEEN :du AND :au OR rs.status IN ('en_retard', 'partiellement_paye'))
        AND ${IMMEUBLE('a.building_id')}) lo,
    (SELECT COALESCE(sum(amount) FILTER (WHERE est_loyer), 0) AS revenus_loyers,
            COALESCE(sum(amount) FILTER (WHERE NOT est_loyer), 0) AS revenus_charges
       FROM (${ENCAISSEMENTS}) enc) en`;

/** § 48 « Qui n'a pas payé ? » — les dix plus gros retards, par locataire et logement. */
const SQL_DEBITEURS = `
  SELECT rs.tenant_id, t.first_name, t.last_name, t.phone,
         rs.apartment_id, a.number AS apartment_number, b.id AS building_id, b.name AS building_name,
         sum(rs.amount_due - rs.amount_paid) AS montant,
         count(*) AS echeances,
         min(rs.due_date)::text AS plus_ancienne_echeance,
         count(*) OVER () AS total_debiteurs
    FROM rent_schedules rs
    JOIN tenants t ON t.id = rs.tenant_id
    JOIN apartments a ON a.id = rs.apartment_id
    JOIN buildings b ON b.id = a.building_id
   WHERE rs.owner_id = :ownerId AND rs.status IN ('en_retard', 'partiellement_paye')
     AND ${ECHEANCE_IMPAYEE} AND ${IMMEUBLE('a.building_id')}
   GROUP BY rs.tenant_id, t.first_name, t.last_name, t.phone, rs.apartment_id, a.number, b.id, b.name
   ORDER BY montant DESC, plus_ancienne_echeance ASC, rs.tenant_id, rs.apartment_id
   LIMIT 10`;

/** § 48 « Quel appartement coûte le plus cher ? » — dépenses des 12 derniers mois. */
const SQL_COUTEUX = `
  SELECT e.apartment_id, a.number AS apartment_number, b.id AS building_id, b.name AS building_name,
         sum(e.amount) AS depenses, count(*) AS nombre
    FROM expenses e
    JOIN apartments a ON a.id = e.apartment_id
    JOIN buildings b ON b.id = a.building_id
   WHERE e.owner_id = :ownerId AND e.status = 'valide' AND e.apartment_id IS NOT NULL
     AND e.spent_on > :depuis AND e.spent_on <= :jour
     AND ${IMMEUBLE('e.building_id')}
   GROUP BY e.apartment_id, a.number, b.id, b.name
   ORDER BY depenses DESC, e.apartment_id
   LIMIT 5`;

/**
 * § 48 « Qu'est-ce qui s'est passé aujourd'hui ? » — même principe que
 * l'historique d'un appartement (§ 25) : UNE requête UNION ALL, à l'échelle
 * du propriétaire, bornée à 20 événements.
 */
const SQL_AUJOURDHUI = `
  SELECT * FROM (
    SELECT rp.created_at AS date, 'paiement_recu' AS type,
           'Paiement ' || rp.reference || ' — ' || t.first_name || ' ' || t.last_name AS libelle,
           rp.amount AS montant, rp.id AS ressource_id, 'rent_payment' AS ressource_type, a.number AS apartment_number
      FROM rent_payments rp
      JOIN tenants t ON t.id = rp.tenant_id
      JOIN apartments a ON a.id = rp.apartment_id
     WHERE rp.owner_id = :ownerId AND rp.status = 'valide' AND rp.paid_on = :jour
       AND ${IMMEUBLE('a.building_id')}
    UNION ALL
    SELECT i.created_at, 'incident_signale', 'Incident signalé — ' || i.title, NULL, i.id, 'incident', a.number
      FROM incidents i
      LEFT JOIN apartments a ON a.id = i.apartment_id
     WHERE i.owner_id = :ownerId AND i.created_at >= ${DEBUT_JOUR(':jour')} AND i.created_at < ${FIN_JOUR(':jour')}
       AND ${IMMEUBLE('i.building_id')}
    UNION ALL
    SELECT w.created_at, 'travaux_crees', 'Travaux #' || lpad(w.number::text, 5, '0') || ' — ' || w.title,
           w.estimated_amount, w.id, 'work_order', a.number
      FROM work_orders w
      LEFT JOIN apartments a ON a.id = w.apartment_id
     WHERE w.owner_id = :ownerId AND w.created_at >= ${DEBUT_JOUR(':jour')} AND w.created_at < ${FIN_JOUR(':jour')}
       AND ${IMMEUBLE('w.building_id')}
    UNION ALL
    SELECT w.completed_at, 'travaux_termines', 'Travaux #' || lpad(w.number::text, 5, '0') || ' terminés — ' || w.title,
           w.actual_amount, w.id, 'work_order', a.number
      FROM work_orders w
      LEFT JOIN apartments a ON a.id = w.apartment_id
     WHERE w.owner_id = :ownerId AND w.status = 'termine'
       AND w.completed_at >= ${DEBUT_JOUR(':jour')} AND w.completed_at < ${FIN_JOUR(':jour')}
       AND ${IMMEUBLE('w.building_id')}
    UNION ALL
    SELECT e.created_at, 'depense', COALESCE(e.description, c.name), -e.amount, e.id, 'expense', a.number
      FROM expenses e
      JOIN expense_categories c ON c.id = e.category_id
      LEFT JOIN apartments a ON a.id = e.apartment_id
     WHERE e.owner_id = :ownerId AND e.status = 'valide' AND e.spent_on = :jour
       AND ${IMMEUBLE('e.building_id')}
  ) evenements
  ORDER BY date DESC, ressource_id
  LIMIT 20`;

const requete = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

async function calculerTableauDeBord(ownerId, buildingId, mois, jour) {
  const du = `${mois}-01`;
  const au = finMois(du);
  const params = {
    ownerId, buildingId, du, au, jour, fuseau: FUSEAU, depuis: ajouterMois(jour, -12),
  };
  const [[c], debiteurs, couteux, evenements] = await Promise.all([
    requete(SQL_CHIFFRES, params),
    requete(SQL_DEBITEURS, params),
    requete(SQL_COUTEUX, params),
    requete(SQL_AUJOURDHUI, params),
  ]);

  const revenusTotal = c.revenus_loyers + c.revenus_charges + c.revenus_autres;
  return {
    mois,
    jour,
    building_id: buildingId,
    patrimoine: {
      immeubles: c.immeubles,
      appartements: c.appartements,
      occupes: c.occupes,
      disponibles: c.disponibles,
      en_travaux: c.en_travaux,
      indisponibles: c.indisponibles,
      taux_occupation: pourcentage(c.occupes, c.appartements),
      taux_vacance: pourcentage(c.disponibles, c.appartements),
    },
    // Loyers du mois par date d'échéance (§ 6 « à recevoir / encaissés ») ;
    // impayés = tout le reste dû échu, quel que soit le mois (§ 4 obj. 18).
    loyers: { a_recevoir: c.a_recevoir, encaisses: c.encaisses, impayes: c.impayes },
    // § 48 « Combien ai-je encaissé ? » — trésorerie réellement reçue dans le
    // mois, caution exclue (§ 55.4).
    revenus: {
      loyers: c.revenus_loyers, charges: c.revenus_charges, autres: c.revenus_autres, total: revenusTotal,
    },
    depenses: c.depenses,
    resultat: revenusTotal - c.depenses,
    travaux_en_cours: c.travaux_en_cours,
    // § 55.4 : « le tableau de bord affiche le total des cautions détenues ».
    cautions_detenues: c.cautions_detenues,
    a_traiter: {
      preuves_a_valider: c.preuves_a_valider,
      a_rapprocher: c.a_rapprocher,
      factures_a_repartir: c.factures_a_repartir,
      incidents_ouverts: c.incidents_ouverts,
    },
    qui_n_a_pas_paye: {
      total_debiteurs: debiteurs[0]?.total_debiteurs || 0,
      locataires: debiteurs.map(({ total_debiteurs: _total, ...l }) => l),
    },
    appartement_le_plus_couteux: couteux,
    aujourd_hui: evenements,
    genere_le: new Date().toISOString(),
  };
}

/** @param {{ mois?: string, building_id?: string }} filtres */
async function tableauDeBord(ownerId, { mois, building_id: buildingId }) {
  // Le contrôle d'accès précède le cache : un immeuble d'autrui → 403, jamais
  // une réponse servie depuis le cache.
  if (buildingId) await verifierReference(Building, buildingId, ownerId, 'Immeuble');
  const jour = aujourdhui();
  const moisVise = mois || jour.slice(0, 7);
  const cle = `dashboard:${ownerId}:${buildingId || 'tous'}:${moisVise}:${jour}`;
  return avecCache(cle, () => calculerTableauDeBord(ownerId, buildingId || null, moisVise, jour));
}

/**
 * Séries mensuelles des graphiques (§ 6). `generate_series` fournit CHAQUE
 * mois de la fenêtre, même vide (courbe continue côté mobile) ; chaque série
 * est un agrégat GROUP BY mois joint à gauche — une requête pour toutes les
 * séries, une autre pour la répartition par catégorie. L'évolution du
 * patrimoine compte ce qui existait à la FIN de chaque mois (créé avant, pas
 * encore supprimé) : la courbe ne se réécrit pas quand un bien est supprimé.
 */
const SQL_SERIES = `
  WITH mois AS (
    SELECT generate_series(CAST(:du AS date), CAST(:au AS date), interval '1 month')::date AS m
  ),
  enc AS (
    SELECT date_trunc('month', paid_on)::date AS m,
           sum(amount) FILTER (WHERE est_loyer) AS loyers,
           sum(amount) FILTER (WHERE NOT est_loyer) AS charges
      FROM (${ENCAISSEMENTS}) x GROUP BY 1
  ),
  autres AS (
    SELECT date_trunc('month', occurred_on)::date AS m, sum(amount) AS total
      FROM (${AUTRES_REVENUS}) x GROUP BY 1
  ),
  dep AS (
    SELECT date_trunc('month', spent_on)::date AS m, sum(amount) AS total
      FROM (${DEPENSES}) x GROUP BY 1
  ),
  ech AS (
    SELECT date_trunc('month', rs.due_date)::date AS m,
           sum(rs.amount_due) AS a_recevoir,
           sum(rs.amount_paid) AS encaisses,
           sum(rs.amount_due - rs.amount_paid) FILTER (WHERE ${ECHEANCE_IMPAYEE}) AS impayes
      FROM rent_schedules rs
      JOIN apartments a ON a.id = rs.apartment_id
     WHERE rs.owner_id = :ownerId AND rs.status <> 'annule' AND rs.due_date BETWEEN :du AND :au
       AND ${IMMEUBLE('a.building_id')}
     GROUP BY 1
  ),
  trv_crees AS (
    SELECT date_trunc('month', w.created_at AT TIME ZONE :fuseau)::date AS m, count(*) AS n
      FROM work_orders w
     WHERE w.owner_id = :ownerId AND w.created_at >= ${DEBUT_JOUR(':du')} AND w.created_at < ${FIN_JOUR(':au')}
       AND ${IMMEUBLE('w.building_id')}
     GROUP BY 1
  ),
  trv_termines AS (
    SELECT date_trunc('month', w.completed_at AT TIME ZONE :fuseau)::date AS m, count(*) AS n
      FROM work_orders w
     WHERE w.owner_id = :ownerId AND w.status = 'termine'
       AND w.completed_at >= ${DEBUT_JOUR(':du')} AND w.completed_at < ${FIN_JOUR(':au')}
       AND ${IMMEUBLE('w.building_id')}
     GROUP BY 1
  ),
  fins AS (
    SELECT m, ((m + interval '1 month')::timestamp AT TIME ZONE :fuseau) AS fin FROM mois
  )
  SELECT to_char(mois.m, 'YYYY-MM') AS mois,
         COALESCE(enc.loyers, 0) AS loyers, COALESCE(enc.charges, 0) AS charges, COALESCE(autres.total, 0) AS autres,
         COALESCE(dep.total, 0) AS depenses,
         COALESCE(ech.a_recevoir, 0) AS a_recevoir, COALESCE(ech.encaisses, 0) AS encaisses, COALESCE(ech.impayes, 0) AS impayes,
         COALESCE(trv_crees.n, 0) AS travaux_crees, COALESCE(trv_termines.n, 0) AS travaux_termines,
         (SELECT count(*) FROM apartments a
           WHERE a.owner_id = :ownerId AND ${IMMEUBLE('a.building_id')}
             AND a.created_at < fins.fin AND (a.deleted_at IS NULL OR a.deleted_at >= fins.fin)) AS appartements,
         (SELECT count(*) FROM buildings b
           WHERE b.owner_id = :ownerId AND ${IMMEUBLE('b.id')}
             AND b.created_at < fins.fin AND (b.deleted_at IS NULL OR b.deleted_at >= fins.fin)) AS immeubles
    FROM mois
    JOIN fins ON fins.m = mois.m
    LEFT JOIN enc ON enc.m = mois.m
    LEFT JOIN autres ON autres.m = mois.m
    LEFT JOIN dep ON dep.m = mois.m
    LEFT JOIN ech ON ech.m = mois.m
    LEFT JOIN trv_crees ON trv_crees.m = mois.m
    LEFT JOIN trv_termines ON trv_termines.m = mois.m
   ORDER BY mois.m`;

async function calculerGraphiques(ownerId, buildingId, moisFin, nbMois, jour) {
  const au = finMois(`${moisFin}-01`);
  const du = debutMois(ajouterMois(`${moisFin}-01`, -(nbMois - 1)));
  const params = {
    ownerId, buildingId, du, au, jour, fuseau: FUSEAU,
  };
  const [series, categories] = await Promise.all([
    requete(SQL_SERIES, params),
    requete(DEPENSES_PAR_CATEGORIE, params),
  ]);
  return {
    periode: {
      mois_debut: du.slice(0, 7), mois_fin: moisFin, nb_mois: nbMois, du, au,
    },
    building_id: buildingId,
    revenus_mensuels: series.map((s) => ({
      mois: s.mois, loyers: s.loyers, charges: s.charges, autres: s.autres, total: s.loyers + s.charges + s.autres,
    })),
    depenses_mensuelles: series.map((s) => ({ mois: s.mois, total: s.depenses })),
    loyers_mensuels: series.map((s) => ({
      mois: s.mois, a_recevoir: s.a_recevoir, encaisses: s.encaisses, impayes: s.impayes,
    })),
    evolution_patrimoine: series.map((s) => ({ mois: s.mois, immeubles: s.immeubles, appartements: s.appartements })),
    depenses_par_categorie: categories,
    travaux_par_periode: series.map((s) => ({ mois: s.mois, crees: s.travaux_crees, termines: s.travaux_termines })),
  };
}

/** @param {{ mois_fin?: string, nb_mois: number, building_id?: string }} filtres */
async function graphiques(ownerId, { mois_fin: moisFin, nb_mois: nbMois, building_id: buildingId }) {
  if (buildingId) await verifierReference(Building, buildingId, ownerId, 'Immeuble');
  const jour = aujourdhui();
  const fin = moisFin || jour.slice(0, 7);
  const cle = `dashboard-graphiques:${ownerId}:${buildingId || 'tous'}:${fin}:${nbMois}:${jour}`;
  return avecCache(cle, () => calculerGraphiques(ownerId, buildingId || null, fin, nbMois, jour));
}

module.exports = { tableauDeBord, graphiques };
