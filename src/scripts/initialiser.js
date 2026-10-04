'use strict';

/**
 * Initialisation idempotente, exécutée à CHAQUE démarrage de conteneur
 * (docker-entrypoint.sh) et par deploy.sh, après les migrations :
 *
 *   1. rôles système et leurs permissions — synchronisés avec le catalogue du
 *      code (config/permissions.js) : une nouvelle permission livrée par un
 *      déploiement est accordée sans intervention manuelle ;
 *   2. compte super admin (ADMIN_EMAIL / ADMIN_PASSWORD) s'il n'existe pas —
 *      mot de passe soumis à la politique renforcée (config/security.js).
 *
 * Usage : node src/scripts/initialiser.js
 */

require('dotenv').config({ quiet: true });
const sequelize = require('../config/db.js');
const { PERMISSIONS_PAR_ROLE } = require('../config/permissions.js');
const { ROLES } = require('../config/enums.js');
const { validerMotDePasseAdmin, bcryptConfig } = require('../config/security.js');
const bcrypt = require('../utils/motDePasse.js');
const logger = require('../utils/logger.js');

async function synchroniserRoles() {
  for (const [code, permissions] of Object.entries(PERMISSIONS_PAR_ROLE)) {
    await sequelize.query(
      `INSERT INTO roles (code, label, permissions, is_system) VALUES (:code, :label, ARRAY[:permissions]::text[], true)
       ON CONFLICT (code) DO UPDATE SET permissions = EXCLUDED.permissions, label = EXCLUDED.label, is_system = true, updated_at = now()`,
      { replacements: { code, label: ROLES[code], permissions } }
    );
  }
  logger.info(`[initialisation] ${Object.keys(PERMISSIONS_PAR_ROLE).length} rôles système synchronisés`);
}

async function assurerSuperAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const motDePasse = process.env.ADMIN_PASSWORD;
  // Créé seulement s'il n'existe AUCUN super admin (constat M2 de l'audit).
  // Auparavant la présence était testée sur l'e-mail de ADMIN_EMAIL : si le
  // super admin changeait d'adresse, le redémarrage suivant recréait un super
  // admin avec le mot de passe resté dans l'environnement — un accès dormant
  // pour quiconque lisait le .env.
  const [superAdmins] = await sequelize.query(
    "SELECT id FROM users WHERE role_code = 'super_admin' AND deleted_at IS NULL LIMIT 1"
  );
  if (superAdmins.length) {
    if (motDePasse) {
      logger.warn('[initialisation] Un super admin existe déjà : retirez ADMIN_PASSWORD de l’environnement (.env), il ne sert plus et ne doit pas y rester.');
    }
    return;
  }
  if (!email) {
    logger.warn('[initialisation] ADMIN_EMAIL non défini — aucun super admin créé');
    return;
  }
  const [existants] = await sequelize.query(
    'SELECT id FROM users WHERE lower(email) = :email AND deleted_at IS NULL',
    { replacements: { email } }
  );
  if (existants.length) {
    logger.error(`[initialisation] Super admin non créé : l'adresse ${email} appartient déjà à un autre compte.`);
    return;
  }

  const erreur = validerMotDePasseAdmin(motDePasse, email);
  if (erreur) throw new Error(`Super admin non créé : ${erreur}`);

  await sequelize.query(
    `INSERT INTO users (role_code, first_name, last_name, email, password_hash, must_change_password)
     VALUES ('super_admin', :prenom, :nom, :email, :empreinte, true)`,
    {
      replacements: {
        prenom: process.env.ADMIN_FIRST_NAME || 'Super',
        nom: process.env.ADMIN_LAST_NAME || 'Admin',
        email,
        empreinte: await bcrypt.hash(motDePasse, bcryptConfig.saltRounds),
      },
    }
  );
  logger.info(`[initialisation] Super admin créé : ${email} (changement de mot de passe exigé à la première connexion)`);
}

async function initialiser() {
  await synchroniserRoles();
  await assurerSuperAdmin();
}

if (require.main === module) {
  initialiser()
    .then(() => sequelize.close())
    .then(() => process.exit(0))
    .catch(async (err) => {
      logger.error(`[initialisation] Échec : ${err.message}`);
      await sequelize.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { initialiser, synchroniserRoles, assurerSuperAdmin };
