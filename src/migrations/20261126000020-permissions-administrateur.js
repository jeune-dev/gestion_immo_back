'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Permissions d'un super administrateur, compte par compte (back-office
 * KODAFRIK : à la création d'un admin, on coche ce qu'il peut faire).
 *
 *   - NULL      : toutes les permissions du rôle super_admin (comportement
 *                 d'avant, et celui des comptes existants) ;
 *   - un tableau de codes `admin.*` : seulement celles-là (auth.middleware
 *                 restreint `req.permissions` à ce sous-ensemble).
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      'ALTER TABLE users ADD COLUMN admin_permissions jsonb',
      "ALTER TABLE users ADD CONSTRAINT users_admin_permissions_tableau CHECK (admin_permissions IS NULL OR jsonb_typeof(admin_permissions) = 'array')",
    ]);
  },

  async down(queryInterface) {
    await executer(queryInterface, [
      'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admin_permissions_tableau',
      'ALTER TABLE users DROP COLUMN IF EXISTS admin_permissions',
    ]);
  },
};
