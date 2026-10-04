'use strict';

const { executer } = require('../database/migrationHelpers.js');

/**
 * Journal d'audit en AJOUT SEUL (constat M6 de l'audit de sécurité).
 *
 * Un déclencheur refuse toute modification, suppression ou vidange de
 * `audit_logs`, quel que soit le rôle PostgreSQL qui la tente : une injection
 * SQL, un accès au serveur ou une erreur d'administration ne peut plus effacer
 * ses traces sans laisser de marque (désactiver le déclencheur exige d'être
 * propriétaire de la table, et l'opération apparaît dans les journaux de
 * PostgreSQL). En complément, le rôle applicatif n'a que INSERT et SELECT sur
 * cette table (src/scripts/rolesBase.js).
 *
 * Purge légale future (durée de conservation) : par une migration dédiée,
 * exécutée avec le rôle propriétaire, qui désactive puis réactive le déclencheur.
 */
module.exports = {
  async up(queryInterface) {
    await executer(queryInterface, [
      `CREATE OR REPLACE FUNCTION audit_logs_ajout_seul() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'Le journal d''audit est en ajout seul : % interdit', TG_OP
           USING ERRCODE = 'insufficient_privilege';
       END $$`,
      `CREATE TRIGGER audit_logs_ajout_seul
         BEFORE UPDATE OR DELETE ON audit_logs
         FOR EACH ROW EXECUTE FUNCTION audit_logs_ajout_seul()`,
      `CREATE TRIGGER audit_logs_ajout_seul_vidange
         BEFORE TRUNCATE ON audit_logs
         FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_ajout_seul()`,
    ]);
  },
  async down(queryInterface) {
    await executer(queryInterface, [
      'DROP TRIGGER IF EXISTS audit_logs_ajout_seul_vidange ON audit_logs',
      'DROP TRIGGER IF EXISTS audit_logs_ajout_seul ON audit_logs',
      'DROP FUNCTION IF EXISTS audit_logs_ajout_seul()',
    ]);
  },
};
