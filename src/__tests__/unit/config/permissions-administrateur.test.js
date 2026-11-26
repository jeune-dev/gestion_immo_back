'use strict';

const { PERMISSIONS_ADMIN, permissionsEffectives } = require('../../../config/permissions.js');

describe('permissionsEffectives', () => {
  const duRole = new Set(PERMISSIONS_ADMIN);

  test('NULL : toutes les permissions du rôle', () => {
    expect(permissionsEffectives(duRole, { role_code: 'super_admin', admin_permissions: null })).toBe(duRole);
  });

  test('tableau : seulement les permissions accordées', () => {
    const p = permissionsEffectives(duRole, { role_code: 'super_admin', admin_permissions: ['admin.dashboard'] });
    expect([...p]).toEqual(['admin.dashboard']);
  });

  test('un autre rôle n’est jamais restreint', () => {
    const r = new Set(['immeuble.lire']);
    expect(permissionsEffectives(r, { role_code: 'proprietaire', admin_permissions: [] })).toBe(r);
  });
});
