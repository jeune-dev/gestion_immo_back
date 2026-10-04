'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { Building } = require('../../../models/index.js');
const { verifierReference } = require('../../../utils/acces.js');
const { FUSEAU, ecartJours } = require('../../../utils/dates.js');
const {
  IMMEUBLE, DEBUT_JOUR, FIN_JOUR, ENCAISSEMENTS, AUTRES_REVENUS, DEPENSES, DEPENSES_PAR_CATEGORIE,
  IMPAYES_A_DATE, OCCUPATION, pourcentage,
} = require('./indicateurs.js');

/**
 * Rapports (§ 26) — financier, immobilier, travaux, locataires — et
 * rentabilité par appartement (§ 4 objectif 21, § 48 « quel appartement coûte
 * le plus cher »). Filtres : période [du, au] obligatoire, immeuble optionnel.
 *
 * Chaque rapport est un petit nombre FIXE de requêtes agrégées lancées en
 * parallèle (jamais une requête par immeuble, par locataire ou par
 * appartement) : le coût ne dépend pas du nombre de lignes affichées (§ 45).
 * Les définitions (revenus, impayés…) sont celles de `indicateurs.js`,
 * partagées avec le tableau de bord.
 */

const STATUTS_TRAVAUX_EN_COURS = "('valide', 'artisan_assigne', 'en_cours')";

const requete = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/**
 * Contexte commun : contrôle d'accès à l'immeuble filtré (422 s'il n'existe
 * pas, 403 s'il appartient à un autre propriétaire — § 32, § 43) et
 * paramètres nommés des requêtes.
 */
async function contexte(ownerId, { du, au, building_id: buildingId }) {
  const building = buildingId
    ? await verifierReference(Building, buildingId, ownerId, 'Immeuble', { attributes: ['id', 'owner_id', 'name'] })
    : null;
  return {
    params: {
      ownerId, buildingId: buildingId || null, du, au, fuseau: FUSEAU, jours: ecartJours(du, au) + 1,
    },
    entete: {
      periode: { du, au, jours: ecartJours(du, au) + 1 },
      building: building ? { id: building.id, name: building.name } : null,
    },
  };
}

// ── Financier ────────────────────────────────────────────────────────────────

const SQL_FIN_TOTAUX = `
  SELECT en.loyers, en.charges, ar.autres, dep.depenses,
         imp.impayes, imp.echeances_impayees, imp.locataires_debiteurs,
         fa.factures_total, fa.nombre_factures, fa.refacture, fa.recupere
    FROM
      (SELECT COALESCE(sum(amount) FILTER (WHERE est_loyer), 0) AS loyers,
              COALESCE(sum(amount) FILTER (WHERE NOT est_loyer), 0) AS charges
         FROM (${ENCAISSEMENTS}) x) en,
      (SELECT COALESCE(sum(amount), 0) AS autres FROM (${AUTRES_REVENUS}) x) ar,
      (SELECT COALESCE(sum(amount), 0) AS depenses FROM (${DEPENSES}) x) dep,
      (SELECT COALESCE(sum(reste), 0) AS impayes, count(*) AS echeances_impayees,
              count(DISTINCT tenant_id) AS locataires_debiteurs
         FROM (${IMPAYES_A_DATE}) x) imp,
      (SELECT COALESCE(sum(ci.amount), 0) AS factures_total, count(*) AS nombre_factures,
              COALESCE(sum(ch.refacture), 0) AS refacture, COALESCE(sum(ch.recupere), 0) AS recupere
         FROM charge_invoices ci
         LEFT JOIN (SELECT c.charge_invoice_id, sum(c.amount) AS refacture, sum(c.amount_paid) AS recupere
                      FROM charges c
                     WHERE c.owner_id = :ownerId AND c.status <> 'annule'
                     GROUP BY c.charge_invoice_id) ch ON ch.charge_invoice_id = ci.id
        WHERE ci.owner_id = :ownerId AND ci.status <> 'annulee'
          AND ci.period_start BETWEEN :du AND :au AND ${IMMEUBLE('ci.building_id')}) fa`;

const SQL_FIN_IMMEUBLES = `
  WITH enc AS (
    SELECT building_id, sum(amount) FILTER (WHERE est_loyer) AS loyers, sum(amount) FILTER (WHERE NOT est_loyer) AS charges
      FROM (${ENCAISSEMENTS}) x GROUP BY building_id
  ),
  ar AS (
    SELECT building_id, sum(amount) AS autres FROM (${AUTRES_REVENUS}) x
     WHERE building_id IS NOT NULL GROUP BY building_id
  ),
  dep AS (SELECT building_id, sum(amount) AS depenses FROM (${DEPENSES}) x GROUP BY building_id),
  imp AS (SELECT building_id, sum(reste) AS impayes FROM (${IMPAYES_A_DATE}) x GROUP BY building_id)
  SELECT b.id AS building_id, b.name,
         COALESCE(enc.loyers, 0) AS loyers, COALESCE(enc.charges, 0) AS charges, COALESCE(ar.autres, 0) AS autres,
         COALESCE(dep.depenses, 0) AS depenses, COALESCE(imp.impayes, 0) AS impayes
    FROM buildings b
    LEFT JOIN enc ON enc.building_id = b.id
    LEFT JOIN ar ON ar.building_id = b.id
    LEFT JOIN dep ON dep.building_id = b.id
    LEFT JOIN imp ON imp.building_id = b.id
   WHERE b.owner_id = :ownerId AND ${IMMEUBLE('b.id')}
     AND (b.deleted_at IS NULL OR enc.building_id IS NOT NULL OR ar.building_id IS NOT NULL
          OR dep.building_id IS NOT NULL OR imp.building_id IS NOT NULL)
   ORDER BY b.name, b.id`;

/**
 * Rapport financier (§ 26) : revenus (loyers, charges récupérées, autres —
 * caution exclue, § 55.4), dépenses par catégorie, impayés à la date de fin,
 * bénéfice net, charges communes (facturées / refacturées / récupérées /
 * restant à la charge du propriétaire) et détail par immeuble.
 *
 * Les factures communes retenues sont celles dont la période COMMENCE dans
 * [du, au] : une facture n'est jamais comptée dans deux rapports consécutifs.
 */
async function financier(ownerId, filtres) {
  const { params, entete } = await contexte(ownerId, filtres);
  const [[t], categories, immeubles] = await Promise.all([
    requete(SQL_FIN_TOTAUX, params),
    requete(DEPENSES_PAR_CATEGORIE, params),
    requete(SQL_FIN_IMMEUBLES, params),
  ]);
  const revenus = t.loyers + t.charges + t.autres;
  return {
    ...entete,
    revenus: {
      loyers: t.loyers, charges_recuperees: t.charges, autres_revenus: t.autres, total: revenus,
    },
    depenses: { total: t.depenses, par_categorie: categories },
    benefice_net: revenus - t.depenses,
    impayes: {
      date: params.au,
      montant: t.impayes,
      echeances: t.echeances_impayees,
      locataires: t.locataires_debiteurs,
    },
    charges: {
      nombre_factures: t.nombre_factures,
      factures_total: t.factures_total,
      refacturees_locataires: t.refacture,
      recuperees_locataires: t.recupere,
      reste_a_recouvrer: t.refacture - t.recupere,
      a_charge_proprietaire: t.factures_total - t.refacture,
    },
    par_immeuble: immeubles.map((b) => {
      const total = b.loyers + b.charges + b.autres;
      return {
        building_id: b.building_id,
        name: b.name,
        revenus: {
          loyers: b.loyers, charges_recuperees: b.charges, autres_revenus: b.autres, total,
        },
        depenses: b.depenses,
        benefice_net: total - b.depenses,
        impayes: b.impayes,
      };
    }),
  };
}

// ── Immobilier ───────────────────────────────────────────────────────────────

const SQL_IMMOBILIER = `
  WITH occ AS (${OCCUPATION}),
  actifs AS (
    SELECT l.apartment_id, l.rent_amount, l.charges_amount
      FROM leases l WHERE l.owner_id = :ownerId AND l.status = 'actif'
  )
  SELECT b.id AS building_id, b.name, b.city,
         count(a.id) AS appartements,
         count(a.id) FILTER (WHERE a.status = 'occupe') AS occupes,
         count(a.id) FILTER (WHERE a.status = 'disponible') AS disponibles,
         count(a.id) FILTER (WHERE a.status = 'en_travaux') AS en_travaux,
         count(a.id) FILTER (WHERE a.status = 'indisponible') AS indisponibles,
         count(ac.apartment_id) AS baux_actifs,
         COALESCE(sum(ac.rent_amount), 0) AS loyer_mensuel_occupes,
         COALESCE(sum(ac.charges_amount), 0) AS charges_mensuelles_occupes,
         COALESCE(sum(a.rent_amount), 0) AS loyer_potentiel,
         COALESCE(sum(a.rent_amount) FILTER (WHERE a.status = 'disponible'), 0) AS manque_a_gagner_vacance,
         COALESCE(sum(LEAST(COALESCE(occ.jours, 0), :jours)), 0) AS jours_occupes
    FROM buildings b
    LEFT JOIN apartments a ON a.building_id = b.id AND a.owner_id = :ownerId AND a.deleted_at IS NULL
    LEFT JOIN actifs ac ON ac.apartment_id = a.id
    LEFT JOIN occ ON occ.apartment_id = a.id
   WHERE b.owner_id = :ownerId AND b.deleted_at IS NULL AND ${IMMEUBLE('b.id')}
   GROUP BY b.id
   ORDER BY b.name, b.id`;

/** Indicateurs d'occupation d'un groupe d'appartements (immeuble ou total). */
function indicateursImmobilier(l, jours) {
  return {
    appartements: l.appartements,
    occupes: l.occupes,
    disponibles: l.disponibles,
    en_travaux: l.en_travaux,
    indisponibles: l.indisponibles,
    // État actuel (statuts) et occupation RÉELLE sur la période (jours de bail).
    taux_occupation: pourcentage(l.occupes, l.appartements),
    taux_vacance: pourcentage(l.disponibles, l.appartements),
    jours_occupes: l.jours_occupes,
    taux_occupation_periode: pourcentage(l.jours_occupes, l.appartements * jours),
    loyers: {
      loyer_mensuel_occupes: l.loyer_mensuel_occupes,
      charges_mensuelles_occupes: l.charges_mensuelles_occupes,
      loyer_moyen: l.baux_actifs ? Math.round(l.loyer_mensuel_occupes / l.baux_actifs) : 0,
      loyer_potentiel: l.loyer_potentiel,
      manque_a_gagner_vacance: l.manque_a_gagner_vacance,
    },
  };
}

const CHAMPS_SOMMES_IMMOBILIER = [
  'appartements', 'occupes', 'disponibles', 'en_travaux', 'indisponibles', 'baux_actifs',
  'loyer_mensuel_occupes', 'charges_mensuelles_occupes', 'loyer_potentiel', 'manque_a_gagner_vacance', 'jours_occupes',
];

/**
 * Rapport immobilier (§ 26) : nombre d'appartements, occupation, vacance,
 * loyers — par immeuble et au total (somme des lignes, sans requête de plus).
 */
async function immobilier(ownerId, filtres) {
  const { params, entete } = await contexte(ownerId, filtres);
  const lignes = await requete(SQL_IMMOBILIER, params);
  const total = Object.fromEntries(CHAMPS_SOMMES_IMMOBILIER.map((c) => [c, lignes.reduce((s, l) => s + l[c], 0)]));
  return {
    ...entete,
    immeubles: lignes.length,
    ...indicateursImmobilier(total, params.jours),
    par_immeuble: lignes.map((l) => ({
      building_id: l.building_id, name: l.name, city: l.city, ...indicateursImmobilier(l, params.jours),
    })),
  };
}

// ── Travaux ──────────────────────────────────────────────────────────────────

/** Travaux CRÉÉS dans la période (population du rapport) et dépenses qui leur sont liées. */
const CTE_TRAVAUX = `
  wo AS (
    SELECT w.id, w.category, w.status, w.contractor_id, w.estimated_amount, w.actual_amount
      FROM work_orders w
     WHERE w.owner_id = :ownerId
       AND w.created_at >= ${DEBUT_JOUR(':du')} AND w.created_at < ${FIN_JOUR(':au')}
       AND ${IMMEUBLE('w.building_id')}
  ),
  dep_wo AS (
    SELECT e.work_order_id, sum(e.amount) AS total
      FROM expenses e
     WHERE e.owner_id = :ownerId AND e.status = 'valide' AND e.work_order_id IN (SELECT id FROM wo)
     GROUP BY e.work_order_id
  )`;

/** Par catégorie ET total général (ligne ROLLUP, catégorie NULL) en une requête. */
const SQL_TRAVAUX_CATEGORIES = `
  WITH ${CTE_TRAVAUX}
  SELECT wo.category, (GROUPING(wo.category) = 1) AS est_total,
         count(*) AS nombre,
         count(*) FILTER (WHERE wo.status = 'termine') AS termines,
         count(*) FILTER (WHERE wo.status IN ${STATUTS_TRAVAUX_EN_COURS}) AS en_cours,
         count(*) FILTER (WHERE wo.status IN ('signale', 'a_valider')) AS en_attente,
         count(*) FILTER (WHERE wo.status = 'annule') AS annules,
         COALESCE(sum(wo.estimated_amount) FILTER (WHERE wo.status <> 'annule'), 0) AS cout_estime,
         COALESCE(sum(wo.actual_amount), 0) AS cout_reel,
         COALESCE(sum(dep_wo.total), 0) AS depenses_liees
    FROM wo
    LEFT JOIN dep_wo ON dep_wo.work_order_id = wo.id
   GROUP BY ROLLUP (wo.category)
   ORDER BY est_total DESC, nombre DESC, wo.category`;

const SQL_TRAVAUX_SITUATION = `
  SELECT
    (SELECT count(*) FROM work_orders w
      WHERE w.owner_id = :ownerId AND w.status = 'termine'
        AND w.completed_at >= ${DEBUT_JOUR(':du')} AND w.completed_at < ${FIN_JOUR(':au')}
        AND ${IMMEUBLE('w.building_id')}) AS termines_sur_periode,
    (SELECT count(*) FROM work_orders w
      WHERE w.owner_id = :ownerId AND w.status IN ${STATUTS_TRAVAUX_EN_COURS}
        AND ${IMMEUBLE('w.building_id')}) AS en_cours_actuellement,
    (SELECT COALESCE(sum(amount), 0) FROM (${DEPENSES}) x WHERE x.work_order_id IS NOT NULL) AS depenses_travaux_periode`;

/**
 * Artisans (§ 24) : travaux confiés sur la période et montants PAYÉS sur la
 * période (dépenses valides portant l'artisan) — la réalité de trésorerie.
 */
const SQL_TRAVAUX_ARTISANS = `
  WITH ${CTE_TRAVAUX},
  tr AS (
    SELECT wo.contractor_id, count(*) AS nombre, count(*) FILTER (WHERE wo.status = 'termine') AS termines,
           COALESCE(sum(wo.actual_amount), 0) AS cout_reel
      FROM wo WHERE wo.contractor_id IS NOT NULL GROUP BY wo.contractor_id
  ),
  paye AS (
    SELECT contractor_id, sum(amount) AS montant FROM (${DEPENSES}) x
     WHERE contractor_id IS NOT NULL GROUP BY contractor_id
  )
  SELECT c.id AS contractor_id, c.name, c.trade, c.phone,
         COALESCE(tr.nombre, 0) AS nombre, COALESCE(tr.termines, 0) AS termines,
         COALESCE(tr.cout_reel, 0) AS cout_reel, COALESCE(paye.montant, 0) AS montant_paye
    FROM contractors c
    LEFT JOIN tr ON tr.contractor_id = c.id
    LEFT JOIN paye ON paye.contractor_id = c.id
   WHERE c.owner_id = :ownerId AND (tr.contractor_id IS NOT NULL OR paye.contractor_id IS NOT NULL)
   ORDER BY montant_paye DESC, nombre DESC, c.name, c.id`;

const TOP_ARTISANS = 10;

/**
 * Rapport travaux (§ 26) : terminés, en cours, coûts (estimé, réel, dépenses
 * liées), par catégorie, et artisans les plus sollicités / les mieux payés.
 */
async function travaux(ownerId, filtres) {
  const { params, entete } = await contexte(ownerId, filtres);
  const [categories, [situation], artisans] = await Promise.all([
    requete(SQL_TRAVAUX_CATEGORIES, params),
    requete(SQL_TRAVAUX_SITUATION, params),
    requete(SQL_TRAVAUX_ARTISANS, params),
  ]);
  const total = categories.find((l) => l.est_total) || {
    nombre: 0, termines: 0, en_cours: 0, en_attente: 0, annules: 0, cout_estime: 0, cout_reel: 0, depenses_liees: 0,
  };
  return {
    ...entete,
    // Travaux créés sur la période, par statut actuel.
    crees_sur_periode: total.nombre,
    termines: total.termines,
    en_cours: total.en_cours,
    en_attente: total.en_attente,
    annules: total.annules,
    couts: { estime: total.cout_estime, reel: total.cout_reel, depenses_liees: total.depenses_liees },
    termines_sur_periode: situation.termines_sur_periode,
    en_cours_actuellement: situation.en_cours_actuellement,
    depenses_travaux_periode: situation.depenses_travaux_periode,
    par_categorie: categories.filter((l) => !l.est_total).map(({ est_total: _e, ...l }) => l),
    artisans: {
      par_montant: artisans.slice(0, TOP_ARTISANS),
      par_nombre: [...artisans]
        .sort((a, b) => b.nombre - a.nombre || b.montant_paye - a.montant_paye || a.name.localeCompare(b.name))
        .slice(0, TOP_ARTISANS),
    },
  };
}

// ── Locataires ───────────────────────────────────────────────────────────────

const SQL_LOC_EFFECTIFS = `
  SELECT
    (SELECT count(DISTINCT l.tenant_id) FROM leases l JOIN apartments a ON a.id = l.apartment_id
      WHERE l.owner_id = :ownerId AND l.status = 'actif' AND ${IMMEUBLE('a.building_id')}) AS actifs,
    (SELECT count(DISTINCT l.tenant_id) FROM leases l JOIN apartments a ON a.id = l.apartment_id
      WHERE l.owner_id = :ownerId AND l.status IN ('actif', 'termine', 'clos')
        AND l.start_date <= :au AND (l.ended_on IS NULL OR l.ended_on >= :du)
        AND ${IMMEUBLE('a.building_id')}) AS actifs_sur_periode`;

/** Arrivées (baux activés) et départs (baux terminés) de la période, en une requête. */
const SQL_LOC_MOUVEMENTS = `
  SELECT * FROM (
    SELECT 'arrivee' AS mouvement, (l.activated_at AT TIME ZONE :fuseau)::date::text AS date,
           l.id AS lease_id, l.reference, l.tenant_id, t.first_name, t.last_name, t.phone,
           a.id AS apartment_id, a.number AS apartment_number, b.name AS building_name,
           l.rent_amount, NULL::text AS motif
      FROM leases l
      JOIN tenants t ON t.id = l.tenant_id
      JOIN apartments a ON a.id = l.apartment_id
      JOIN buildings b ON b.id = a.building_id
     WHERE l.owner_id = :ownerId AND l.activated_at >= ${DEBUT_JOUR(':du')} AND l.activated_at < ${FIN_JOUR(':au')}
       AND ${IMMEUBLE('a.building_id')}
    UNION ALL
    SELECT 'depart', l.ended_on::text, l.id, l.reference, l.tenant_id, t.first_name, t.last_name, t.phone,
           a.id, a.number, b.name, l.rent_amount, l.termination_reason
      FROM leases l
      JOIN tenants t ON t.id = l.tenant_id
      JOIN apartments a ON a.id = l.apartment_id
      JOIN buildings b ON b.id = a.building_id
     WHERE l.owner_id = :ownerId AND l.status IN ('termine', 'clos') AND l.ended_on BETWEEN :du AND :au
       AND ${IMMEUBLE('a.building_id')}
  ) m
  ORDER BY date, mouvement, reference`;

const SQL_LOC_IMPAYES = `
  SELECT x.tenant_id, t.first_name, t.last_name, t.phone,
         string_agg(DISTINCT a.number, ', ') AS apartments,
         sum(x.reste) AS montant, count(*) AS echeances, min(x.due_date)::text AS plus_ancienne_echeance
    FROM (${IMPAYES_A_DATE}) x
    JOIN tenants t ON t.id = x.tenant_id
    JOIN apartments a ON a.id = x.apartment_id
   GROUP BY x.tenant_id, t.first_name, t.last_name, t.phone
   ORDER BY montant DESC, x.tenant_id`;

/** Rapport locataires (§ 26) : actifs, arrivées, départs, impayés par locataire à la date de fin. */
async function locataires(ownerId, filtres) {
  const { params, entete } = await contexte(ownerId, filtres);
  const [[effectifs], mouvements, impayes] = await Promise.all([
    requete(SQL_LOC_EFFECTIFS, params),
    requete(SQL_LOC_MOUVEMENTS, params),
    requete(SQL_LOC_IMPAYES, params),
  ]);
  const sansType = ({ mouvement: _m, ...l }) => l;
  const arrivees = mouvements.filter((m) => m.mouvement === 'arrivee').map(sansType);
  const departs = mouvements.filter((m) => m.mouvement === 'depart').map(sansType);
  return {
    ...entete,
    actifs: effectifs.actifs,
    actifs_sur_periode: effectifs.actifs_sur_periode,
    arrivees: { nombre: arrivees.length, baux: arrivees },
    departs: { nombre: departs.length, baux: departs },
    impayes: {
      date: params.au,
      total: impayes.reduce((s, l) => s + l.montant, 0),
      locataires: impayes,
    },
  };
}

// ── Rentabilité ──────────────────────────────────────────────────────────────

/** Tri autorisé → expression SQL (liste blanche : jamais de colonne venant du client). */
const TRIS_RENTABILITE = {
  resultat_net: 'resultat_net',
  revenus: 'revenus',
  depenses: 'depenses',
  jours_occupation: 'jours_occupation',
  number: 'apartment_number',
};

function ordreRentabilite(tri) {
  const valeur = tri || '-resultat_net';
  const desc = valeur.startsWith('-');
  const colonne = TRIS_RENTABILITE[desc ? valeur.slice(1) : valeur];
  return `${colonne} ${desc ? 'DESC' : 'ASC'}, apartment_id`;
}

/**
 * Rentabilité de CHAQUE appartement sur la période (§ 4 obj. 21, § 48) :
 * revenus encaissés (loyers, charges récupérées, autres revenus rattachés à
 * l'appartement — caution exclue, § 55.4), dépenses rattachées à
 * l'appartement, résultat net, jours et taux d'occupation, rang par résultat.
 * Les dépenses d'immeuble non rattachées à un appartement n'y figurent pas
 * (elles sont dans le rapport financier par immeuble).
 *
 * UNE requête : agrégats GROUP BY par appartement joints à gauche, rang et
 * total par fonctions de fenêtre, pagination SQL. `limit` nul = export complet.
 */
const sqlRentabilite = (ordre) => `
  WITH enc AS (
    SELECT apartment_id, sum(amount) FILTER (WHERE est_loyer) AS loyers, sum(amount) FILTER (WHERE NOT est_loyer) AS charges
      FROM (${ENCAISSEMENTS}) x GROUP BY apartment_id
  ),
  ar AS (
    SELECT apartment_id, sum(amount) AS autres FROM (${AUTRES_REVENUS}) x
     WHERE apartment_id IS NOT NULL GROUP BY apartment_id
  ),
  dep AS (
    SELECT apartment_id, sum(amount) AS depenses, count(*) AS nombre FROM (${DEPENSES}) x
     WHERE apartment_id IS NOT NULL GROUP BY apartment_id
  ),
  occ AS (${OCCUPATION}),
  lignes AS (
    SELECT a.id AS apartment_id, a.number AS apartment_number, a.type, a.status, a.rent_amount,
           b.id AS building_id, b.name AS building_name,
           COALESCE(enc.loyers, 0) AS loyers,
           COALESCE(enc.charges, 0) AS charges_recuperees,
           COALESCE(ar.autres, 0) AS autres_revenus,
           COALESCE(enc.loyers, 0) + COALESCE(enc.charges, 0) + COALESCE(ar.autres, 0) AS revenus,
           COALESCE(dep.depenses, 0) AS depenses,
           COALESCE(dep.nombre, 0) AS nombre_depenses,
           COALESCE(enc.loyers, 0) + COALESCE(enc.charges, 0) + COALESCE(ar.autres, 0) - COALESCE(dep.depenses, 0) AS resultat_net,
           LEAST(COALESCE(occ.jours, 0), :jours) AS jours_occupation
      FROM apartments a
      JOIN buildings b ON b.id = a.building_id
      LEFT JOIN enc ON enc.apartment_id = a.id
      LEFT JOIN ar ON ar.apartment_id = a.id
      LEFT JOIN dep ON dep.apartment_id = a.id
      LEFT JOIN occ ON occ.apartment_id = a.id
     WHERE a.owner_id = :ownerId AND a.deleted_at IS NULL AND ${IMMEUBLE('a.building_id')}
  )
  SELECT *, round(100.0 * jours_occupation / :jours, 1)::float AS taux_occupation,
         rank() OVER (ORDER BY resultat_net DESC) AS rang,
         count(*) OVER () AS total
    FROM lignes
   ORDER BY ${ordre}
   LIMIT :limit OFFSET :offset`;

/**
 * @param {{ limit: number|null, offset: number }} pagination  limit nul : toutes les lignes (export)
 */
async function rentabilite(ownerId, filtres, { limit, offset }) {
  const { params, entete } = await contexte(ownerId, filtres);
  const lignes = await requete(sqlRentabilite(ordreRentabilite(filtres.tri)), { ...params, limit, offset });
  return {
    entete,
    count: lignes[0] ? lignes[0].total : 0,
    rows: lignes.map(({ total: _t, ...l }) => l),
  };
}

module.exports = {
  financier, immobilier, travaux, locataires, rentabilite,
};
