'use strict';

/**
 * Politique du mot de passe super-admin (reprise de Widjila). Module PUR (sans
 * lecture de l'environnement) : utilisable par config/security.js comme par le
 * générateur de secrets, qui s'exécute avant que les secrets n'existent.
 */

const ADMIN_MDP_MOTIFS_FAIBLES = [
  'password', 'motdepasse', 'azerty', 'qwerty', '123456', 'admin', 'changeme', 'bienvenue', 'immo',
];

/**
 * Vérifie la robustesse d'un mot de passe super-admin. Retourne un message
 * d'erreur, ou null s'il est conforme.
 */
function validerMotDePasseAdmin(motDePasse, email) {
  if (!motDePasse) return 'ADMIN_PASSWORD est requis.';
  if (motDePasse.length < 12) return 'ADMIN_PASSWORD doit contenir au moins 12 caractères.';
  if (!/[a-z]/.test(motDePasse) || !/[A-Z]/.test(motDePasse) || !/\d/.test(motDePasse) || !/[^a-zA-Z0-9]/.test(motDePasse)) {
    return 'ADMIN_PASSWORD doit contenir une minuscule, une majuscule, un chiffre et un caractère spécial.';
  }
  const bas = motDePasse.toLowerCase();
  const motif = ADMIN_MDP_MOTIFS_FAIBLES.find((m) => bas.includes(m));
  if (motif) return `ADMIN_PASSWORD contient un motif trop prévisible (« ${motif} »).`;
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && bas.includes(local)) return "ADMIN_PASSWORD ne doit pas contenir l'adresse e-mail.";
  return null;
}

module.exports = { validerMotDePasseAdmin, ADMIN_MDP_MOTIFS_FAIBLES };
