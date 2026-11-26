'use strict';

/**
 * Politique du mot de passe super-admin (reprise de Widjila). Module PUR (sans
 * lecture de l'environnement) : utilisable par config/security.js comme par le
 * générateur de secrets, qui s'exécute avant que les secrets n'existent.
 */

const ADMIN_MDP_MOTIFS_FAIBLES = [
  'password', 'motdepasse', 'azerty', 'qwerty', '123456', 'admin', 'changeme', 'bienvenue', 'immo',
];

/** Longueur minimale d'un mot de passe, pour tous les comptes. */
const LONGUEUR_MIN = 8;

/**
 * Mot de passe d'un super admin. Retourne un message d'erreur, ou null s'il
 * est conforme.
 *
 * SIMPLIFIÉ (26/11/2026, back-office KODAFRIK) : plus d'exigence de
 * minuscule, majuscule, chiffre ou caractère spécial, ni de liste de mots
 * interdits — seulement 8 caractères au moins, comme pour tous les comptes.
 * La protection de l'administration tient au code d'accès à quatre chiffres
 * exigé par le serveur, au verrouillage après 5 échecs et à la limite de
 * débit des connexions.
 */
function validerMotDePasseAdmin(motDePasse) {
  if (!motDePasse) return 'ADMIN_PASSWORD est requis.';
  if (motDePasse.length < LONGUEUR_MIN) return `ADMIN_PASSWORD doit contenir au moins ${LONGUEUR_MIN} caractères.`;
  if (motDePasse.length > 128) return 'ADMIN_PASSWORD ne doit pas dépasser 128 caractères.';
  return null;
}

module.exports = { validerMotDePasseAdmin, ADMIN_MDP_MOTIFS_FAIBLES, LONGUEUR_MIN };
