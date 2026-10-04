'use strict';

const {
  api, MOT_DE_PASSE, nouveauProprietaire, superAdmin, emailUnique, fermer, sequelize,
} = require('../../../setup/helpers.js');

/**
 * CORRECTIF M9 de l'audit de sécurité — connexions tracées dans le journal
 * d'audit (réussites ET échecs, avec leur motif), sans jamais y écrire
 * l'identifiant tenté en clair. Base de la détection d'un bourrage
 * d'identifiants ou d'une attaque par pulvérisation de mots de passe.
 */

afterAll(fermer);

const connexion = (identifiant, password = MOT_DE_PASSE) => api().post('/api/v1/auth/connexion').send({ identifiant, password });
async function derniere(action, entityId) {
  const [lignes] = await sequelize.query(
    `SELECT user_id, entity_id, actor_role, details, ip FROM audit_logs
      WHERE action = :action AND ${entityId ? 'entity_id = :entityId' : 'entity_id IS NULL'} ORDER BY id DESC LIMIT 1`,
    { replacements: { action, entityId: entityId || null } }
  );
  return lignes[0];
}

describe('Traçage des connexions', () => {
  test('réussite : tracée au nom du titulaire, avec IP', async () => {
    const p = await nouveauProprietaire();
    expect((await connexion(p.identifiants.email)).status).toBe(200);
    const trace = await derniere('compte.connexion', p.user.id);
    expect(trace).toMatchObject({ user_id: p.user.id, details: { identifiant_empreinte: expect.stringMatching(/^[0-9a-f]{16}$/) } });
    expect(trace.ip).toEqual(expect.any(String));
  });

  test('mot de passe faux : échec tracé (motif), NON imputé au titulaire, identifiant jamais en clair', async () => {
    const p = await nouveauProprietaire();
    expect((await connexion(p.identifiants.email, 'Mauvais123')).status).toBe(401);
    const trace = await derniere('compte.connexion_echec', p.user.id);
    expect(trace).toMatchObject({ user_id: null, actor_role: 'anonyme', details: { motif: 'mot_de_passe' } });
    expect(JSON.stringify(trace)).not.toContain(p.identifiants.email);
    // Même empreinte que la connexion réussie du même compte : les essais se regroupent.
    await connexion(p.identifiants.email);
    expect((await derniere('compte.connexion', p.user.id)).details.identifiant_empreinte).toBe(trace.details.identifiant_empreinte);
  });

  test('compte inconnu : échec tracé sans compte associé', async () => {
    const inconnu = emailUnique('personne');
    expect((await connexion(inconnu)).status).toBe(401);
    const [lignes] = await sequelize.query(
      "SELECT details FROM audit_logs WHERE action = 'compte.connexion_echec' AND entity_id IS NULL AND details->>'motif' = 'compte_inconnu' ORDER BY id DESC LIMIT 5"
    );
    expect(lignes.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(lignes)).not.toContain(inconnu);
  });

  test('compte verrouillé : les nouvelles tentatives sont tracées', async () => {
    const p = await nouveauProprietaire();
    await sequelize.query("UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id = :u", { replacements: { u: p.user.id } });
    await connexion(p.identifiants.email);
    expect((await derniere('compte.connexion_echec', p.user.id)).details.motif).toBe('compte_verrouille');
  });

  test('double authentification : l’étape « mot de passe valide » est tracée, la connexion complète aussi', async () => {
    const admin = await superAdmin();
    expect((await derniere('compte.connexion_mot_de_passe_valide', admin.user.id)).details.motif).toBe('double_authentification_requise');
    expect(await derniere('compte.connexion_double_authentification', admin.user.id)).toBeDefined();
  });
});
