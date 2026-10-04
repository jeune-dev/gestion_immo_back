'use strict';

const {
  nouveauProprietaire, superAdmin, emailUnique, compter, fermer, sequelize,
} = require('../../../setup/helpers.js');
const { assurerSuperAdmin } = require('../../../../scripts/initialiser.js');
const logger = require('../../../../utils/logger.js');

/**
 * CORRECTIF M2 de l'audit de sécurité — le super admin INITIAL (ADMIN_EMAIL /
 * ADMIN_PASSWORD, script exécuté à chaque démarrage de conteneur) n'est créé
 * que s'il n'existe AUCUN super admin. Auparavant, un super admin qui changeait
 * d'e-mail voyait un nouveau compte recréé au redémarrage suivant, avec le mot
 * de passe resté dans l'environnement.
 */

const MDP_AMORCE = 'Kx7!mQ2#vLp9Tz';
const ENV = { ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };

afterEach(() => {
  process.env.ADMIN_EMAIL = ENV.ADMIN_EMAIL ?? '';
  process.env.ADMIN_PASSWORD = ENV.ADMIN_PASSWORD ?? '';
  jest.restoreAllMocks();
});
afterAll(fermer);

const superAdminsActifs = () => compter('users', "role_code = 'super_admin' AND deleted_at IS NULL");

/** Exécute `fn` comme si la base ne contenait AUCUN super admin (retrait logique temporaire). */
async function sansSuperAdmin(fn) {
  const [ids] = await sequelize.query("UPDATE users SET deleted_at = now() WHERE role_code = 'super_admin' AND deleted_at IS NULL RETURNING id");
  try {
    return await fn();
  } finally {
    await sequelize.query('UPDATE users SET deleted_at = NULL WHERE id IN (:ids)', { replacements: { ids: ids.length ? ids.map((l) => l.id) : ['00000000-0000-4000-8000-000000000000'] } });
  }
}

describe('Super admin initial (script d’initialisation)', () => {
  test('un super admin existe déjà (e-mail changé depuis) : AUCUN compte recréé au redémarrage, rappel de retirer ADMIN_PASSWORD', async () => {
    await superAdmin();
    const avertissement = jest.spyOn(logger, 'warn');
    const emailInitial = emailUnique('admin.initial');
    process.env.ADMIN_EMAIL = emailInitial; // l'adresse initiale n'existe plus
    process.env.ADMIN_PASSWORD = MDP_AMORCE;
    const avant = await superAdminsActifs();
    await assurerSuperAdmin();
    expect(await superAdminsActifs()).toBe(avant);
    expect(await compter('users', 'lower(email) = :e', { e: emailInitial })).toBe(0);
    expect(avertissement.mock.calls.some(([m]) => /retirez ADMIN_PASSWORD/.test(m))).toBe(true);
  });

  test('aucun super admin : le compte initial est créé (mot de passe provisoire à changer), une seule fois', async () => {
    await sansSuperAdmin(async () => {
      const email = emailUnique('admin.amorce');
      process.env.ADMIN_EMAIL = email;
      process.env.ADMIN_PASSWORD = MDP_AMORCE;
      await assurerSuperAdmin();
      await assurerSuperAdmin(); // redémarrage : rien de plus
      expect(await compter('users', "lower(email) = :e AND role_code = 'super_admin' AND must_change_password", { e: email })).toBe(1);
      await sequelize.query('DELETE FROM users WHERE lower(email) = :e', { replacements: { e: email } });
    });
  });

  test('aucun super admin mais l’e-mail appartient à un autre compte : rien créé, erreur journalisée (démarrage non bloqué)', async () => {
    const p = await nouveauProprietaire();
    await sansSuperAdmin(async () => {
      const erreur = jest.spyOn(logger, 'error');
      process.env.ADMIN_EMAIL = p.identifiants.email;
      process.env.ADMIN_PASSWORD = MDP_AMORCE;
      await expect(assurerSuperAdmin()).resolves.toBeUndefined();
      expect(await compter('users', "role_code = 'super_admin' AND deleted_at IS NULL")).toBe(0);
      expect(erreur.mock.calls.some(([m]) => /appartient déjà/.test(m))).toBe(true);
    });
  });

  test('aucun super admin et mot de passe d’amorçage faible : refus (politique renforcée)', async () => {
    await sansSuperAdmin(async () => {
      process.env.ADMIN_EMAIL = emailUnique('admin.faible');
      process.env.ADMIN_PASSWORD = 'Password123';
      await expect(assurerSuperAdmin()).rejects.toThrow(/Super admin non créé/);
    });
  });
});
