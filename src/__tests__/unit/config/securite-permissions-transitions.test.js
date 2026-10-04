'use strict';

const { validerMotDePasseAdmin, jwtConfig, cookieRefresh } = require('../../../config/security.js');
const { P, TOUTES, PERMISSIONS_PAR_ROLE } = require('../../../config/permissions.js');
const transitions = require('../../../config/transitions.js');
const enums = require('../../../config/enums.js');

/**
 * Configuration de sécurité (§ 32) : politique du mot de passe super admin,
 * jetons, cookie ; cohérence du catalogue de permissions (RBAC) et des tables
 * de transitions des workflows.
 */

describe('validerMotDePasseAdmin', () => {
  test('mot de passe robuste : null', () => {
    expect(validerMotDePasseAdmin('Xk9#vLq2!mRt', 'awa.sow@test.sn')).toBeNull();
  });

  test.each([
    [undefined, /requis/],
    ['', /requis/],
    ['Xk9#vLq2!mR', /12 caractères/],
    ['xk9#vlq2!mrt', /majuscule/],
    ['XK9#VLQ2!MRT', /minuscule/],
    ['Xkq#vLqz!mRt', /chiffre/],
    ['Xk9vLq2mRtAb', /spécial/],
    ['Password#2026', /prévisible/],
    ['Azerty#12345x', /prévisible/],
    ['MonImmo#2026x', /prévisible/],
  ])('« %s » refusé', (mdp, motif) => {
    expect(validerMotDePasseAdmin(mdp, 'x@test.sn')).toMatch(motif);
  });

  test('contenir la partie locale de l’e-mail (≥ 4 caractères) est refusé ; plus courte, toléré', () => {
    expect(validerMotDePasseAdmin('Moussa#2026xy', 'moussa@test.sn')).toMatch(/e-mail/);
    expect(validerMotDePasseAdmin('Xk9#abcLq2!m', 'abc@test.sn')).toBeNull();
  });
});

describe('Jetons et cookie', () => {
  test('HS256 uniquement, secrets d’accès et de refresh distincts, accès court', () => {
    expect(jwtConfig.algorithme).toBe('HS256');
    expect(jwtConfig.secret).not.toBe(jwtConfig.refreshSecret);
    expect(jwtConfig.expiresIn).toBe('15m');
  });

  test('cookie de refresh : httpOnly, SameSite strict, limité aux routes d’authentification', () => {
    expect(cookieRefresh).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/api/v1/auth' });
  });
});

describe('Permissions (RBAC)', () => {
  test('catalogue sans doublon, au format « domaine.action »', () => {
    expect(new Set(TOUTES).size).toBe(TOUTES.length);
    for (const p of TOUTES) expect(p).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  test('chaque permission d’un rôle existe dans le catalogue', () => {
    for (const perms of Object.values(PERMISSIONS_PAR_ROLE)) {
      for (const p of perms) expect(TOUTES).toContain(p);
    }
  });

  test('les rôles sont exactement ceux de l’énumération ROLES', () => {
    expect(Object.keys(PERMISSIONS_PAR_ROLE).sort()).toEqual(Object.keys(enums.ROLES).sort());
  });

  test('permissions admin.* : au super admin SEULEMENT ; il n’a rien d’autre', () => {
    expect(PERMISSIONS_PAR_ROLE.super_admin.length).toBeGreaterThan(0);
    expect(PERMISSIONS_PAR_ROLE.super_admin.every((p) => p.startsWith('admin.'))).toBe(true);
    expect(PERMISSIONS_PAR_ROLE.proprietaire.some((p) => p.startsWith('admin.'))).toBe(false);
    expect(PERMISSIONS_PAR_ROLE.locataire.some((p) => p.startsWith('admin.'))).toBe(false);
  });

  test('locataire : uniquement locataire.* ; propriétaire : aucune locataire.*', () => {
    expect(PERMISSIONS_PAR_ROLE.locataire.every((p) => p.startsWith('locataire.'))).toBe(true);
    expect(PERMISSIONS_PAR_ROLE.proprietaire.some((p) => p.startsWith('locataire.'))).toBe(false);
  });

  test('toute permission du catalogue est attribuée à au moins un rôle', () => {
    const attribuees = new Set(Object.values(PERMISSIONS_PAR_ROLE).flat());
    for (const p of TOUTES) expect(attribuees.has(p)).toBe(true);
  });

  test('catalogue gelé (aucune modification à l’exécution)', () => {
    expect(Object.isFrozen(P)).toBe(true);
    expect(Object.isFrozen(TOUTES)).toBe(true);
  });
});

describe('Tables de transitions', () => {
  const TABLES = { TRAVAUX: transitions.TRAVAUX, INCIDENT: transitions.INCIDENT, ETAT_DES_LIEUX: transitions.ETAT_DES_LIEUX };
  const TERMINAUX = { TRAVAUX: ['termine', 'annule'], INCIDENT: ['resolu', 'rejete'], ETAT_DES_LIEUX: ['remplace'] };

  test.each(Object.keys(TABLES))('%s : aucune transition hors d’un état terminal', (nom) => {
    for (const etat of TERMINAUX[nom]) expect(TABLES[nom][etat]).toEqual([]);
  });

  test.each(Object.keys(TABLES))('%s : toute cible est un état connu, jamais soi-même', (nom) => {
    const table = TABLES[nom];
    for (const [de, cibles] of Object.entries(table)) {
      for (const vers of cibles) {
        expect(Object.keys(table)).toContain(vers);
        expect(vers).not.toBe(de);
      }
    }
  });

  test('états cohérents avec les énumérations', () => {
    expect(Object.keys(transitions.TRAVAUX).sort()).toEqual(Object.keys(enums.STATUT_TRAVAUX).sort());
    expect(Object.keys(transitions.INCIDENT).sort()).toEqual(Object.keys(enums.STATUT_INCIDENT).sort());
  });

  test('verifierTransition : permise, interdite (409 TRANSITION_INVALIDE), identique', () => {
    expect(() => transitions.verifierTransition(transitions.INCIDENT, 'signale', 'resolu', 'Incident')).not.toThrow();
    for (const [de, vers] of [['resolu', 'signale'], ['signale', 'signale'], ['inconnu', 'resolu']]) {
      let erreur;
      try { transitions.verifierTransition(transitions.INCIDENT, de, vers, 'Incident'); } catch (e) { erreur = e; }
      expect(erreur).toMatchObject({ statusCode: 409, code: 'TRANSITION_INVALIDE' });
    }
  });

  test('tables gelées', () => {
    for (const table of Object.values(TABLES)) expect(Object.isFrozen(table)).toBe(true);
  });
});
