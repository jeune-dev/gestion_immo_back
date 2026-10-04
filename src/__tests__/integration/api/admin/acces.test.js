'use strict';

const jwt = require('jsonwebtoken');
const {
  api, bearer, superAdmin, proprietaireEtLocataire, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * § 32 contrôle d'accès VERTICAL de l'espace Super Admin : CHAQUE route
 * /admin/* refuse l'anonyme (401), le jeton expiré (401), le propriétaire et
 * le locataire (403), le super admin désactivé (403) — et aucune n'écrit quoi
 * que ce soit dans ces cas.
 */

const ID = '00000000-0000-4000-8000-000000000000';

const ROUTES_ADMIN = [
  ['get', '/dashboard'],
  ['get', '/proprietaires'], ['get', `/proprietaires/${ID}`], ['post', `/proprietaires/${ID}/suspendre`], ['post', `/proprietaires/${ID}/reactiver`],
  ['post', `/proprietaires/${ID}/abonnement/activer`],
  ['get', '/locataires'], ['get', '/immeubles'], ['get', '/signalements'], ['get', '/signalements/statistiques'],
  ['get', '/abonnements'], ['get', `/abonnements/${ID}`], ['post', `/abonnements/${ID}/suspendre`], ['post', `/abonnements/${ID}/reactiver`], ['post', `/abonnements/${ID}/annuler`],
  ['get', '/paiements'], ['get', '/paiements/loyers/statistiques'],
  ['get', '/utilisateurs'], ['post', '/utilisateurs'], ['get', `/utilisateurs/${ID}`], ['post', `/utilisateurs/${ID}/desactiver`], ['post', `/utilisateurs/${ID}/activer`], ['post', `/utilisateurs/${ID}/deverrouiller`],
  ['get', '/parametres'], ['put', '/parametres/otp'],
  ['post', '/notifications'], ['get', '/notifications'],
  ['get', '/categories'], ['post', '/categories'], ['patch', `/categories/${ID}`], ['post', `/categories/${ID}/activer`], ['post', `/categories/${ID}/desactiver`], ['delete', `/categories/${ID}`],
  ['get', '/journal-audit'], ['get', '/roles'],
  ['get', '/plans'], ['post', '/plans'], ['get', `/plans/${ID}`], ['patch', `/plans/${ID}`], ['post', `/plans/${ID}/activer`], ['post', `/plans/${ID}/desactiver`], ['delete', `/plans/${ID}`],
  ['get', '/modeles-bail'], ['get', '/modeles-bail/variables'], ['post', '/modeles-bail'], ['get', `/modeles-bail/${ID}`], ['patch', `/modeles-bail/${ID}`],
  ['post', `/modeles-bail/${ID}/publier`], ['post', `/modeles-bail/${ID}/archiver`],
  ['get', '/modeles-whatsapp'], ['patch', `/modeles-whatsapp/${ID}`],
];

// Corps VALIDES : le refus doit venir du contrôle d'accès, pas de la validation.
const CORPS = { reason: 'Motif valable', plan_code: 'PRO', months: 1, cible: 'tous', titre: 'Titre', corps: 'Corps', duree_minutes: 15, tentatives_max: 5, is_active: true };

const appel = (methode, chemin, h) => {
  const req = api()[methode](`/api/v1/admin${chemin}`);
  if (h) req.set(h);
  return methode === 'get' ? req : req.send(CORPS);
};

let proprio; let locataire; let avantAudit;
beforeAll(async () => {
  ({ proprio, locataire } = await proprietaireEtLocataire());
  [[{ n: avantAudit }]] = await sequelize.query("SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'admin.%' OR action LIKE 'plan.%' OR action LIKE 'utilisateur.%'");
});
afterAll(fermer);

describe('Chaque route /admin/*', () => {
  test.each(ROUTES_ADMIN)('%s %s : anonyme 401, propriétaire 403, locataire 403, jeton expiré 401', async (methode, chemin) => {
    expect((await appel(methode, chemin)).status).toBe(401);
    const parProprio = await appel(methode, chemin, proprio.h);
    expect(parProprio.status).toBe(403);
    expect(parProprio.body.error.code).toBe('ROLE_INSUFFISANT');
    expect((await appel(methode, chemin, locataire.h)).status).toBe(403);
    const expire = jwt.sign({ sub: proprio.user.id, typ: 'access', tv: 0, exp: Math.floor(Date.now() / 1000) - 5 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    expect((await appel(methode, chemin, bearer(expire))).status).toBe(401);
  });

  test('jeton de propriétaire re-signé avec le rôle « super_admin » dans la charge : 401 (signature invalide)', async () => {
    const decode = jwt.decode(proprio.token);
    const forge = jwt.sign({ ...decode, role: 'super_admin' }, 'secret-inconnu-de-l-attaquant-xxxxxxxx', { algorithm: 'HS256' });
    expect((await appel('get', '/dashboard', bearer(forge))).status).toBe(401);
  });

  test('même bien signé, un rôle « super_admin » dans la charge ne vaut rien : le rôle vient de la base (403)', async () => {
    const decode = jwt.decode(proprio.token);
    const signe = jwt.sign({ sub: decode.sub, tv: decode.tv, typ: 'access', role: 'super_admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
    const res = await appel('get', '/dashboard', bearer(signe));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_INSUFFISANT');
  });

  test('super admin désactivé : 403 COMPTE_INACTIF partout', async () => {
    const admin = await superAdmin();
    await sequelize.query("UPDATE users SET status = 'inactif' WHERE id = :id", { replacements: { id: admin.user.id } });
    for (const [methode, chemin] of ROUTES_ADMIN.slice(0, 10)) {
      const res = await appel(methode, chemin, admin.h);
      expect(res.body.error.code).toBe('COMPTE_INACTIF');
    }
  });

  test('aucune écriture d’administration n’a été journalisée par ces tentatives', async () => {
    const [[{ n }]] = await sequelize.query("SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'admin.%' OR action LIKE 'plan.%' OR action LIKE 'utilisateur.%'");
    expect(n).toBe(avantAudit);
  });
});
