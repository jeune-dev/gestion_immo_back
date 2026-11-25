'use strict';

/**
 * Secret des codes à usage unique (réinitialisation du mot de passe,
 * vérification de l'adresse à l'inscription) : seule une empreinte HMAC est
 * stockée.
 *
 * Secret DÉDIÉ `OTP_SECRET` (constat F2 de l'audit) : réutiliser JWT_SECRET
 * liait deux usages — une fuite de l'un compromettait l'autre. Hors production,
 * repli sur JWT_SECRET pour ne pas casser les environnements existants ; en
 * production OTP_SECRET est exigée au démarrage (config/security.js).
 */
const secretOtp = () => process.env.OTP_SECRET || process.env.JWT_SECRET;

module.exports = { secretOtp };
