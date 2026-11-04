'use strict';

const sequelize = require('../../../config/db.js');
const { verrouillageConfig, formaterDelai } = require('../../../config/security.js');
const { CompteBloqueError } = require('../../../errors/AppError.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const { alerter, TYPES } = require('../../../infrastructure/alertes.service.js');

/**
 * Verrouillage progressif d'un compte après des essais incorrects (mot de
 * passe ou code de double authentification), commun à auth.service et
 * mfa.service.
 *
 * Toutes les `maxTentatives` erreurs, le compte est bloqué pour le palier
 * suivant (1 min, 5 min, 15 min par défaut ; le dernier palier se répète).
 * Le compteur n'est PAS remis à zéro au blocage — c'est lui qui fait monter
 * les paliers — mais à la première connexion réussie.
 *
 * Les comptes existants n'ont plus de réponse indiscernable d'un mot de passe
 * faux (ancien constat M4) : l'inscription révèle déjà qu'un numéro est
 * utilisé, et l'utilisateur bloqué ne comprenait pas pourquoi son BON mot de
 * passe était refusé. Il voit maintenant le temps d'attente réel.
 */

/**
 * « Mot de passe oublié » (qui lève le blocage) n'est proposé qu'aux comptes
 * qui ont un e-mail : le code y est envoyé.
 */
function messageBloque(user, delai) {
  const conseil = user.email
    ? 'Réessayez ensuite, ou utilisez « Mot de passe oublié » pour le débloquer tout de suite.'
    : 'Réessayez ensuite.';
  return `Trop d'essais incorrects : par sécurité, votre compte est bloqué pendant ${delai}. ${conseil}`;
}

/** Secondes restantes d'un blocage en cours, ou 0. */
function secondesRestantes(user) {
  const fin = user?.locked_until ? new Date(user.locked_until).getTime() : 0;
  return Math.max(0, Math.ceil((fin - Date.now()) / 1000));
}

/** Lève COMPTE_BLOQUE si le compte est bloqué en ce moment. */
function verifierNonBloque(user) {
  const s = secondesRestantes(user);
  if (s > 0) throw new CompteBloqueError(messageBloque(user, formaterDelai(s * 1000)), s);
}

/**
 * Compte un essai incorrect (incrément ATOMIQUE : des essais parallèles ne se
 * neutralisent pas) et bloque le compte au bout de chaque série.
 * @returns {Promise<{ essaisRestants: number }>}  essais avant le prochain blocage
 * @throws {CompteBloqueError} si cet essai déclenche le blocage
 */
async function enregistrerEchec(user, motif) {
  const { maxTentatives: max, paliersMinutes } = verrouillageConfig;
  const [[ligne]] = await sequelize.query(
    `UPDATE users SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE WHEN (failed_login_attempts + 1) % :max = 0
              THEN now() + make_interval(mins => (CAST(:paliers AS int[]))[LEAST((failed_login_attempts + 1) / :max, :nb)])
              ELSE locked_until END
      WHERE id = :id RETURNING failed_login_attempts, locked_until`,
    { replacements: { id: user.id, max, paliers: `{${paliersMinutes.join(',')}}`, nb: paliersMinutes.length } }
  );
  const echecs = ligne?.failed_login_attempts ?? 0;
  if (echecs > 0 && echecs % max === 0) {
    await journaliser({ action: 'compte.verrouillage', entityType: 'user', entityId: user.id, acteur: user, details: { motif, echecs } });
    if (user.role_code === 'super_admin') {
      alerter(TYPES.VERROUILLAGE_SUPER_ADMIN, 'Compte super administrateur verrouillé après des essais incorrects successifs', { utilisateurId: user.id, motif });
    }
    verifierNonBloque({ role_code: user.role_code, email: user.email, locked_until: ligne.locked_until });
  }
  return { essaisRestants: max - (echecs % max) };
}

/** Connexion réussie : le compteur et le blocage repartent de zéro. */
async function reinitialiser(user) {
  if (user.failed_login_attempts || user.locked_until) {
    await user.update({ failed_login_attempts: 0, locked_until: null });
  }
}

module.exports = { verifierNonBloque, enregistrerEchec, reinitialiser, secondesRestantes };
