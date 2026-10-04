'use strict';

const rateLimit = require('express-rate-limit');
const redisClient = require('../../../config/redis.js');
const { otpCibleRateLimitConfig } = require('../../../config/security.js');
const { StoreRedisResilient, journalStore } = require('../../../middlewares/rateLimit.middleware.js');
const { normaliserTelephone } = require('../../../utils/telephone.js');

/**
 * Limite des activations de compte locataire PAR TÉLÉPHONE ciblé (§ 32 anti
 * force brute). Le limiteur par IP (`authRateLimit`) ne suffit pas : un
 * attaquant qui change d'IP (4G, proxys) pourrait essayer des codes à 8
 * chiffres contre le même locataire. La clé est le téléphone NORMALISÉ :
 * « 77 123 45 67 » et « +221771234567 » partagent le même compteur.
 *
 * Complète le plafond de 5 essais par invitation (invitation.service.js) :
 * le premier borne le débit, le second le nombre total d'essais.
 *
 * L'activation par LIEN (jeton de 256 bits, sans téléphone) n'est pas
 * concernée : elle n'est pas devinable.
 */
function creerLimiteActivation(config = otpCibleRateLimitConfig) {
  const store = redisClient
    ? new StoreRedisResilient({ prefix: 'rl:activation:', sendCommand: (...args) => redisClient.call(...args) })
    : undefined;
  return rateLimit({
    ...config,
    ...(store ? { store, passOnStoreError: true, logger: journalStore } : {}),
    keyGenerator: (req) => `activation:${normaliserTelephone(req.body?.phone) || String(req.body?.phone).trim()}`,
    skip: (req) => !req.body?.phone,
  });
}

module.exports = { creerLimiteActivation, limiteActivation: creerLimiteActivation() };
