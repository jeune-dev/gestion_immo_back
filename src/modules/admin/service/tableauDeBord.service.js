'use strict';

const { QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { aujourdhui, debutMois, finMois } = require('../../../utils/dates.js');
const cache = require('../../../utils/cache.js');

/**
 * Tableau de bord du Super Admin (§ 29) : propriétaires, locataires,
 * immeubles, appartements, volume mensuel de loyers, paiements, abonnements.
 *
 * Trois requêtes d'agrégat pour toute la plateforme (jamais de requête par
 * propriétaire), servies depuis un cache de 60 s : l'écran d'accueil de
 * l'administration peut être rouvert à volonté sans balayer les tables
 * financières à chaque fois. `volUnique` évite que plusieurs administrateurs
 * relancent le calcul ensemble à l'expiration du cache.
 */

const CLE = 'admin:dashboard';
const TTL_S = 60;

const entier = (v) => Number(v || 0);

/** Prix mensualisé d'une formule (MRR) : une formule annuelle compte pour 1/12. */
const mensuel = (prix, periode) => (periode === 'annuel' ? Math.round(entier(prix) / 12) : entier(prix));

async function calculer() {
  const jour = aujourdhui();
  const debut = debutMois(jour);
  const fin = finMois(jour);

  const [comptes, paiements, abonnements] = await Promise.all([
    sequelize.query(
      `SELECT
         (SELECT count(*) FROM owners WHERE deleted_at IS NULL) AS owners,
         (SELECT count(*) FROM owners WHERE deleted_at IS NULL AND status = 'suspendu') AS owners_suspended,
         (SELECT count(*) FROM tenants WHERE deleted_at IS NULL) AS tenants,
         (SELECT count(*) FROM buildings WHERE deleted_at IS NULL) AS buildings,
         (SELECT count(*) FROM apartments WHERE deleted_at IS NULL) AS apartments,
         (SELECT count(*) FROM apartments WHERE deleted_at IS NULL AND status = 'occupe') AS apartments_occupied,
         (SELECT count(*) FROM apartments WHERE deleted_at IS NULL AND status = 'disponible') AS apartments_available,
         (SELECT coalesce(sum(amount_due), 0) FROM rent_schedules
           WHERE status <> 'annule' AND due_date BETWEEN :debut AND :fin) AS rent_due,
         (SELECT coalesce(sum(amount_paid), 0) FROM rent_schedules
           WHERE status <> 'annule' AND due_date BETWEEN :debut AND :fin) AS rent_collected`,
      { replacements: { debut, fin }, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT method, count(*) AS nombre, coalesce(sum(amount), 0) AS montant
         FROM rent_payments
        WHERE status = 'valide' AND paid_on BETWEEN :debut AND :fin
        GROUP BY method ORDER BY method`,
      { replacements: { debut, fin }, type: QueryTypes.SELECT }
    ),
    sequelize.query(
      `SELECT s.status, p.code, p.name, p.price, p.billing_period,
              count(*) AS nombre,
              count(*) FILTER (WHERE s.status = 'actif' AND s.current_period_end >= :jour) AS payants
         FROM subscriptions s
         JOIN subscription_plans p ON p.id = s.plan_id
        GROUP BY s.status, p.code, p.name, p.price, p.billing_period`,
      { replacements: { jour }, type: QueryTypes.SELECT }
    ),
  ]);

  const c = comptes[0];
  const parStatut = {};
  const parPlan = {};
  let mrr = 0;
  for (const l of abonnements) {
    parStatut[l.status] = (parStatut[l.status] || 0) + entier(l.nombre);
    // Répartition par formule : abonnements COURANTS seulement (l'historique
    // des périodes expirées fausserait la photographie).
    if (['essai', 'actif', 'suspendu'].includes(l.status)) {
      parPlan[l.code] = parPlan[l.code] || { code: l.code, name: l.name, count: 0 };
      parPlan[l.code].count += entier(l.nombre);
    }
    // MRR : abonnements PAYÉS et en cours ; un essai ne rapporte rien.
    mrr += entier(l.payants) * mensuel(l.price, l.billing_period);
  }

  const occupes = entier(c.apartments_occupied);
  const total = entier(c.apartments);
  return {
    period: { start: debut, end: fin },
    owners: { total: entier(c.owners), suspended: entier(c.owners_suspended) },
    tenants: entier(c.tenants),
    buildings: entier(c.buildings),
    apartments: {
      total,
      occupied: occupes,
      available: entier(c.apartments_available),
      occupancy_rate: total ? Math.round((occupes / total) * 1000) / 10 : 0,
    },
    rent: { due: entier(c.rent_due), collected: entier(c.rent_collected) },
    payments: {
      count: paiements.reduce((s, p) => s + entier(p.nombre), 0),
      amount: paiements.reduce((s, p) => s + entier(p.montant), 0),
      by_method: paiements.map((p) => ({ method: p.method, count: entier(p.nombre), amount: entier(p.montant) })),
    },
    subscriptions: {
      by_status: parStatut,
      by_plan: Object.values(parPlan),
      mrr,
    },
    generated_at: new Date().toISOString(),
  };
}

async function tableauDeBord() {
  const enCache = await cache.lire(CLE);
  if (enCache) return enCache;
  return cache.volUnique(CLE, async () => {
    const resultat = await calculer();
    await cache.ecrire(CLE, resultat, TTL_S);
    return resultat;
  });
}

module.exports = { tableauDeBord, calculer };
