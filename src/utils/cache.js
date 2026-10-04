'use strict';

const redisClient = require('../config/redis.js');
const logger = require('./logger.js');

/**
 * Cache applicatif best-effort (audit — Charge à 10 000 utilisateurs §4).
 *
 * Avec Redis (`REDIS_URL`) : cache PARTAGÉ par tous les workers.
 *
 * Sans Redis — CORRECTIF (audit performance) : toutes les fonctions étaient
 * des no-op. Or le déploiement Docker tourne sur un seul process sans Redis :
 * le tableau de bord, écran d'accueil de chaque session et requête la plus
 * lourde du produit, était recalculé à CHAQUE ouverture. On garde désormais
 * un repli en mémoire du process, borné en nombre d'entrées et en durée. Il
 * n'est pas partagé entre workers (chacun recalcule au plus une fois par
 * TTL), ce qui reste cohérent pour des agrégats déjà servis avec 45 s de
 * retard par conception.
 *
 * Un échec Redis ponctuel (timeout, reconnexion) ne fait JAMAIS échouer une
 * requête métier : l'erreur est journalisée en `debug` et l'appel continue
 * sans cache.
 */

/** Plafond du repli mémoire : au-delà, l'entrée la plus ancienne sort. */
const MAX_ENTREES_MEMOIRE = 500;
const memoire = new Map(); // cle → { valeur, expireA }

function lireMemoire(cle) {
  const entree = memoire.get(cle);
  if (!entree) return null;
  if (entree.expireA <= Date.now()) {
    memoire.delete(cle);
    return null;
  }
  return entree.valeur;
}

function ecrireMemoire(cle, valeur, ttlSecondes) {
  if (memoire.has(cle)) memoire.delete(cle); // réinsertion : redevient la plus récente
  memoire.set(cle, { valeur, expireA: Date.now() + ttlSecondes * 1000 });
  while (memoire.size > MAX_ENTREES_MEMOIRE) memoire.delete(memoire.keys().next().value);
}

/** Motif glob Redis (`*`, `?`) → expression régulière, pour le repli mémoire. */
const versRegex = (motif) => new RegExp(
  `^${motif.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`
);

const lire = async (cle) => {
  if (!redisClient) return lireMemoire(cle);
  try {
    const brut = await redisClient.get(cle);
    return brut ? JSON.parse(brut) : null;
  } catch (err) {
    logger.debug(`[cache] lecture échouée pour ${cle}`, { error: err.message });
    return null;
  }
};

const ecrire = async (cle, valeur, ttlSecondes = 45) => {
  if (!redisClient) {
    ecrireMemoire(cle, valeur, ttlSecondes);
    return;
  }
  try {
    await redisClient.set(cle, JSON.stringify(valeur), 'EX', ttlSecondes);
  } catch (err) {
    logger.debug(`[cache] écriture échouée pour ${cle}`, { error: err.message });
  }
};

/**
 * Invalide toutes les clés correspondant à un motif (ex: `dashboard:*:orgId`).
 *
 * `SCAN` par lots et non `KEYS` : `KEYS` parcourt TOUT l'espace de clés en
 * une commande, pendant laquelle Redis ne sert plus personne — ni ce cache,
 * ni les limiteurs de débit qui partagent la même instance.
 */
const invalider = async (motif) => {
  if (!redisClient) {
    const regex = versRegex(motif);
    for (const cle of [...memoire.keys()]) if (regex.test(cle)) memoire.delete(cle);
    return;
  }
  try {
    let curseur = '0';
    do {
      const [suivant, cles] = await redisClient.scan(curseur, 'MATCH', motif, 'COUNT', 200);
      curseur = suivant;
      if (cles.length) await redisClient.del(...cles);
    } while (curseur !== '0');
  } catch (err) {
    logger.debug(`[cache] invalidation échouée pour ${motif}`, { error: err.message });
  }
};

/**
 * Calcul « à vol unique » : des appels simultanés pour la MÊME clé partagent
 * un seul calcul au lieu d'en lancer un chacun.
 *
 * Sans lui, à l'expiration d'une entrée, chaque utilisateur qui ouvrait le
 * tableau de bord dans la même seconde relançait toutes ses requêtes
 * d'agrégation — l'effet de meute, qui vidait le pool de connexions au
 * moment précis où le cache devait le protéger.
 */
const enVol = new Map();
const volUnique = (cle, calcul) => {
  if (enVol.has(cle)) return enVol.get(cle);
  const promesse = Promise.resolve()
    .then(calcul)
    .finally(() => enVol.delete(cle));
  enVol.set(cle, promesse);
  return promesse;
};

module.exports = {
  lire, ecrire, invalider, volUnique,
  // Exposé pour les tests : taille du repli mémoire et remise à zéro.
  _memoire: { taille: () => memoire.size, vider: () => memoire.clear(), MAX_ENTREES_MEMOIRE },
};
