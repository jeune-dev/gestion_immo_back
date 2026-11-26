'use strict';

/**
 * Le code d'accès à quatre chiffres des super administrateurs.
 *
 * COMPTES AU CODE FIXE : leur code est écrit ici (haché bcrypt) et ne peut
 * être changé ni depuis le dashboard ni par l'API — seul ce code ouvre leur
 * session. Pour en changer, remplacer le hachage :
 *   node -e "console.log(require('bcryptjs').hashSync('1234', 12))"
 */
const COMPTES_CODE_FIXE = Object.freeze({
  // kodafrik_admin@gmail.com : 0000
  'kodafrik_admin@gmail.com': '$2a$12$othLbpwr.5sYqr/h.2YuBebdztawok1zVOwESTNIQLA0dDGnO8tIK',
});

module.exports = {
  COMPTES_CODE_FIXE,
  REGLE_CODE: /^\d{4}$/,
  ECHECS_MAX: Number(process.env.CODE_ACCES_ECHECS_MAX || 5),
  BLOCAGE_MS: Number(process.env.CODE_ACCES_BLOCAGE_MIN || 15) * 60 * 1000,
  /**
   * Le serveur exige le code pour toute route /admin. CODE_ACCES_ADMIN_OBLIGATOIRE=false
   * seulement en dépannage : l'administration redevient ouverte au seul mot de passe.
   */
  obligatoire: () => process.env.CODE_ACCES_ADMIN_OBLIGATOIRE !== 'false',
};
