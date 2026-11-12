'use strict';

/**
 * Crée un super admin depuis le serveur, ou rétablit son accès, sans passer
 * par un autre super admin : pour le jour où plus personne ne peut se
 * connecter, ou pour ouvrir le compte du back-office KODAFRIK.
 *
 *   node scripts/creer-super-admin.js <email> "<mot de passe>" [prénom] [nom]
 *
 * En production (Docker), depuis le dossier de l'API sur le serveur :
 *   docker compose -f docker-compose.prod.yml exec backend node scripts/creer-super-admin.js <email> "<mot de passe>"
 *
 * - Adresse inconnue : le compte est créé avec le rôle super_admin.
 * - Super admin existant : nouveau mot de passe, verrouillage levé, double
 *   authentification à reconfigurer, toutes ses sessions fermées — comme
 *   « Réinitialiser l'accès » dans l'administration.
 * - Adresse prise par un autre type de compte : refus. Un propriétaire ne
 *   devient pas super admin par une faute de frappe.
 *
 * Le mot de passe suit la politique renforcée du super admin
 * (src/config/validationMotDePasse.js). Il n'est PAS provisoire : c'est la
 * personne qui lance la commande, sur le serveur, qui le choisit. La double
 * authentification reste obligatoire et se configure à la première ouverture
 * du back-office. L'opération est inscrite au journal d'audit.
 *
 * Placé dans scripts/ et non dans src/ : c'est un outil d'exploitation, comme
 * rattrapage-coherence.js, hors du périmètre de couverture des tests.
 */

require('dotenv').config({ quiet: true });
const sequelize = require('../src/config/db.js');
const { validerMotDePasseAdmin, bcryptConfig } = require('../src/config/security.js');
const bcrypt = require('../src/utils/motDePasse.js');

const USAGE = 'Usage : node scripts/creer-super-admin.js <email> "<mot de passe>" [prénom] [nom]';
const FORMAT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function creerSuperAdmin({ email, motDePasse, prenom = 'Admin', nom = 'Kodafrik' }) {
  const adresse = String(email || '').trim().toLowerCase();
  if (!FORMAT_EMAIL.test(adresse)) throw new Error(`Adresse e-mail invalide : « ${email || ''} ».`);
  const erreur = validerMotDePasseAdmin(motDePasse, adresse);
  if (erreur) throw new Error(erreur.replace('ADMIN_PASSWORD', 'Le mot de passe'));

  const [roles] = await sequelize.query("SELECT code FROM roles WHERE code = 'super_admin'");
  if (!roles.length) {
    throw new Error('Le rôle super_admin est absent de la base : lancez d’abord « npm run migrate » puis « npm run init ».');
  }

  const empreinte = await bcrypt.hash(motDePasse, bcryptConfig.saltRounds);

  return sequelize.transaction(async (transaction) => {
    const [trouves] = await sequelize.query(
      'SELECT id, role_code FROM users WHERE lower(email) = :adresse AND deleted_at IS NULL FOR UPDATE',
      { replacements: { adresse }, transaction }
    );
    const existant = trouves[0];
    if (existant && existant.role_code !== 'super_admin') {
      throw new Error(`L’adresse ${adresse} appartient déjà à un compte « ${existant.role_code} » : choisissez-en une autre.`);
    }

    let id;
    if (existant) {
      ({ id } = existant);
      await sequelize.query(
        `UPDATE users SET password_hash = :empreinte, must_change_password = false, status = 'actif',
           failed_login_attempts = 0, locked_until = NULL,
           totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, mfa_recovery_codes = CAST('[]' AS jsonb),
           token_version = token_version + 1, updated_at = now()
         WHERE id = :id`,
        { replacements: { empreinte, id }, transaction }
      );
      await sequelize.query(
        "UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'globale' WHERE user_id = :id AND revoked_at IS NULL",
        { replacements: { id }, transaction }
      );
    } else {
      const [crees] = await sequelize.query(
        `INSERT INTO users (role_code, first_name, last_name, email, password_hash, must_change_password)
         VALUES ('super_admin', :prenom, :nom, :adresse, :empreinte, false)
         RETURNING id`,
        { replacements: { prenom, nom, adresse, empreinte }, transaction }
      );
      ({ id } = crees[0]);
    }

    await sequelize.query(
      `INSERT INTO audit_logs (actor_role, action, entity_type, entity_id, details)
       VALUES ('systeme', :action, 'user', :id, CAST(:details AS jsonb))`,
      {
        replacements: {
          action: existant ? 'utilisateur.reinitialisation_acces' : 'utilisateur.creation',
          id,
          details: JSON.stringify({ role: 'super_admin', email: adresse, origine: 'scripts/creer-super-admin.js' }),
        },
        transaction,
      }
    );
    return { id, adresse, cree: !existant };
  });
}

if (require.main === module) {
  const [email, motDePasse, prenom, nom] = process.argv.slice(2);
  if (!email || !motDePasse) {
    console.error(USAGE);
    process.exit(1);
  }
  creerSuperAdmin({ email, motDePasse, prenom, nom })
    .then(async ({ adresse, cree }) => {
      console.log(cree
        ? `Super admin créé : ${adresse}`
        : `Super admin ${adresse} : nouveau mot de passe enregistré, sessions fermées, double authentification à reconfigurer.`);
      console.log('À la première ouverture du back-office, configurez la double authentification (obligatoire).');
      await sequelize.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`Échec : ${err.message}`);
      await sequelize.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { creerSuperAdmin };
