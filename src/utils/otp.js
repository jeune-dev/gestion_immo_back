'use strict';

const crypto = require('crypto');

/**
 * Codes à usage unique (réinitialisation du mot de passe, vérification du
 * téléphone) : seule une empreinte HMAC est stockée.
 *
 * Secret DÉDIÉ `OTP_SECRET` (constat F2 de l'audit) : réutiliser JWT_SECRET
 * liait deux usages — une fuite de l'un compromettait l'autre. Hors production,
 * repli sur JWT_SECRET pour ne pas casser les environnements existants ; en
 * production OTP_SECRET est exigée au démarrage (config/security.js).
 */
const secret = () => process.env.OTP_SECRET || process.env.JWT_SECRET;

/** Empreinte d'un code, liée à son contexte (identifiant d'utilisateur, téléphone…). */
const empreinteOtp = (contexte, code) => crypto.createHmac('sha256', secret()).update(`${contexte}:${code}`).digest('hex');

/** Code numérique aléatoire (CSPRNG) de `longueur` chiffres. */
const genererCode = (longueur = 6) => String(crypto.randomInt(0, 10 ** longueur)).padStart(longueur, '0');

module.exports = { empreinteOtp, genererCode };
