'use strict';

const crypto = require('crypto');

/**
 * Empreinte d'un jeton de rafraîchissement, telle que stockée dans
 * `refresh_tokens.token_hash`.
 *
 * SHA-256 et non bcrypt : le jeton est déjà un secret à haute entropie signé
 * par le serveur (pas un mot de passe choisi par un humain), et la colonne
 * porte un index UNIQUE — il faut donc une empreinte déterministe, ce qu'un
 * hash salé ne donnerait pas.
 *
 * Partagée entre `auth.service` (qui écrit les empreintes) et
 * `account.service` (qui doit en retrouver une pour épargner la session
 * courante lors d'un changement de mot de passe). Recopier ces trois lignes
 * de part et d'autre suffirait à les faire diverger un jour, et la panne
 * serait silencieuse : plus aucune correspondance, donc TOUTES les sessions
 * révoquées, y compris celle de l'appareil qui vient de changer son mot de
 * passe.
 */
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

module.exports = hashToken;
