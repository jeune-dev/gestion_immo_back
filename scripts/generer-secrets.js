'use strict';

/**
 * Génère un jeu COMPLET de secrets neufs pour un environnement (production,
 * préproduction…) — constat M1 de l'audit : jamais les mêmes valeurs que le
 * développement ou les tests, un secret par usage.
 *
 * Usage : npm run secrets:generer            (affiche les lignes à coller dans .env)
 *
 * Rien n'est écrit sur disque : copiez la sortie dans le .env du serveur
 * (droits 600), et gardez une copie de APP_ENC_KEY dans le coffre-fort
 * hors serveur (sans elle, les données chiffrées sont irrécupérables).
 */
const crypto = require('crypto');
const { validerMotDePasseAdmin } = require('../src/config/validationMotDePasse.js');

const aleatoire = (octets) => crypto.randomBytes(octets).toString('base64url');

/** Mot de passe d'amorçage du super admin, conforme à la politique renforcée. */
function motDePasseAdmin() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
  for (;;) {
    const candidat = Array.from(crypto.randomBytes(20), (o) => alphabet[o % alphabet.length]).join('');
    if (!validerMotDePasseAdmin(candidat, '')) return candidat;
  }
}

function genererSecrets() {
  return {
    JWT_SECRET: aleatoire(48),
    JWT_REFRESH_SECRET: aleatoire(48),
    INVITATION_SECRET: aleatoire(48),
    APP_ENC_KEY: crypto.randomBytes(32).toString('base64'),
    METRICS_TOKEN: aleatoire(32),
    // Hexadécimal : inclus tel quel dans l'URL redis://:<mot de passe>@redis:6379.
    REDIS_PASSWORD: crypto.randomBytes(32).toString('hex'),
    // Rôle PostgreSQL applicatif (limité) et propriétaire du schéma (migrations).
    DB_PASSWORD: crypto.randomBytes(24).toString('hex'),
    DB_ADMIN_PASSWORD: crypto.randomBytes(24).toString('hex'),
    ADMIN_PASSWORD: motDePasseAdmin(),
  };
}

if (require.main === module) {
  const secrets = genererSecrets();
  process.stdout.write([
    '# Secrets générés le ' + new Date().toISOString() + ' — à coller dans le .env du serveur (chmod 600).',
    '# APP_ENC_KEY : en garder une copie dans le coffre-fort HORS serveur.',
    '# ADMIN_PASSWORD : sert UNE fois (premier démarrage) ; retirez-le du .env ensuite.',
    ...Object.entries(secrets).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n'));
}

module.exports = { genererSecrets };
