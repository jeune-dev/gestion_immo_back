'use strict';

const { api, superAdmin, compter, fermer, sequelize } = require('../../../setup/helpers.js');

/**
 * § 53.4 modèles de bail versionnés (brouillon → publié → archivé, version
 * publiée immuable) et § 54.3 modèles WhatsApp.
 */

const BAUX = '/api/v1/admin/modeles-bail';
const WHATSAPP = '/api/v1/admin/modeles-whatsapp';
const INCONNU = '00000000-0000-4000-8000-000000000000';
const CORPS = 'Contrat {{bail.reference}} entre {{bailleur.nom}} et {{locataire.nom}}, loyer {{bail.loyer}}.';

let admin;
beforeAll(async () => { admin = await superAdmin(); });
afterAll(fermer);

const creerModele = async (surcharges = {}) => {
  const res = await api().post(BAUX).set(admin.h).send({ lease_type: 'professionnel', title: 'Bail commercial', body: CORPS, ...surcharges });
  expect(res.status).toBe(201);
  return res.body.data.template;
};

describe('Modèles de bail', () => {
  test('création : brouillon, version suivante, auteur, audit ; détail avec le texte', async () => {
    const m = await creerModele({ legal_notes: 'Relu par Me Ba' });
    expect(m).toMatchObject({ status: 'brouillon', lease_type: 'professionnel', created_by: admin.user.id });
    const [[max]] = await sequelize.query("SELECT max(version) AS v FROM lease_templates WHERE lease_type = 'professionnel'");
    expect(m.version).toBe(max.v);
    expect(await compter('audit_logs', "action = 'modele_bail.creation' AND entity_id = :id", { id: m.id })).toBe(1);
    expect((await api().get(`${BAUX}/${m.id}`).set(admin.h)).body.data.template.body).toBe(CORPS);
    expect((await api().get(`${BAUX}/${INCONNU}`).set(admin.h)).status).toBe(404);
  });

  test('concurrence : 4 créations simultanées du même type → 4 numéros de version distincts et consécutifs', async () => {
    const reponses = await Promise.all(Array.from({ length: 4 }, (_, i) => api().post(BAUX).set(admin.h)
      .send({ lease_type: 'professionnel', title: `Version parallèle ${i}`, body: CORPS })));
    expect(reponses.every((r) => r.status === 201)).toBe(true);
    const versions = reponses.map((r) => r.body.data.template.version).sort((a, b) => a - b);
    expect(new Set(versions).size).toBe(4);
    expect(versions[3] - versions[0]).toBe(3);
  });

  test.each([
    ['type manquant', { title: 'Titre', body: CORPS }],
    ['type inconnu', { lease_type: 'saisonnier', title: 'Titre', body: CORPS }],
    ['titre de 2 caractères', { lease_type: 'meuble', title: 'Ti', body: CORPS }],
    ['titre de 151 caractères', { lease_type: 'meuble', title: 't'.repeat(151), body: CORPS }],
    ['texte de 19 caractères', { lease_type: 'meuble', title: 'Titre', body: 'x'.repeat(19) }],
    ['notes de 5001 caractères', { lease_type: 'meuble', title: 'Titre', body: CORPS, legal_notes: 'n'.repeat(5001) }],
  ])('création 422 : %s', async (_l, corps) => {
    const avant = await compter('lease_templates');
    expect((await api().post(BAUX).set(admin.h).send(corps)).status).toBe(422);
    expect(await compter('lease_templates')).toBe(avant);
  });

  test('statut et auteur de publication ignorés à la création', async () => {
    const m = await creerModele({ status: 'publie', published_by: INCONNU, version: 999 });
    expect(m.status).toBe('brouillon');
    expect(m.published_by).toBeNull();
    expect(m.version).not.toBe(999);
  });

  test('cycle : brouillon modifiable → publié (immuable) → archivé ; publier archive la version précédente', async () => {
    const a = await creerModele();
    const b = await creerModele();
    expect((await api().patch(`${BAUX}/${a.id}`).set(admin.h).send({ body: `${CORPS} Clause ajoutée.` })).status).toBe(200);
    const [[audit]] = await sequelize.query("SELECT details FROM audit_logs WHERE action = 'modele_bail.modification' AND entity_id = :id", { replacements: { id: a.id } });
    expect(audit.details.body).toBe('modifié');
    expect((await api().post(`${BAUX}/${a.id}/publier`).set(admin.h).send({})).status).toBe(200);
    expect((await api().post(`${BAUX}/${b.id}/publier`).set(admin.h).send({})).status).toBe(200);
    expect(await compter('lease_templates', "lease_type = 'professionnel' AND status = 'publie'")).toBe(1);
    const [[etatA]] = await sequelize.query('SELECT status FROM lease_templates WHERE id = :id', { replacements: { id: a.id } });
    expect(etatA.status).toBe('archive');
    for (const action of ['publier', 'archiver']) expect((await api().post(`${BAUX}/${a.id}/${action}`).set(admin.h).send({})).status).toBe(409);
    expect((await api().patch(`${BAUX}/${a.id}`).set(admin.h).send({ title: 'Retouche' })).body.error.code).toBe('MODELE_IMMUABLE');
    // Une version publiée peut être retirée (archivée), jamais modifiée.
    expect((await api().patch(`${BAUX}/${b.id}`).set(admin.h).send({ title: 'Retouche' })).status).toBe(409);
    expect((await api().post(`${BAUX}/${b.id}/archiver`).set(admin.h).send({})).body.data.template.status).toBe('archive');
    expect(await compter('lease_templates', "lease_type = 'professionnel' AND status = 'publie'")).toBe(0);
  });

  test('modification : corps vide 422, variable inconnue 422, inconnu 404 ; publication / archivage inconnus 404', async () => {
    const m = await creerModele();
    expect((await api().patch(`${BAUX}/${m.id}`).set(admin.h).send({})).status).toBe(422);
    expect((await api().patch(`${BAUX}/${m.id}`).set(admin.h).send({ body: `${CORPS} {{bail.secret}}` })).body.error.code).toBe('MODELE_INVALIDE');
    expect((await api().patch(`${BAUX}/${INCONNU}`).set(admin.h).send({ title: 'Titre' })).status).toBe(404);
    expect((await api().post(`${BAUX}/${INCONNU}/publier`).set(admin.h).send({})).status).toBe(404);
    expect((await api().post(`${BAUX}/${INCONNU}/archiver`).set(admin.h).send({})).status).toBe(404);
  });

  test('liste : filtres type et statut, sans le texte ; filtres invalides 422', async () => {
    await creerModele();
    const res = await api().get(BAUX).query({ lease_type: 'professionnel', status: 'brouillon' }).set(admin.h);
    expect(res.body.data.templates.length).toBeGreaterThan(0);
    expect(res.body.data.templates.every((t) => t.lease_type === 'professionnel' && t.status === 'brouillon' && !('body' in t))).toBe(true);
    expect((await api().get(BAUX).query({ status: 'supprime' }).set(admin.h)).status).toBe(422);
    expect((await api().get(BAUX).query({ lease_type: "' OR 1=1 --" }).set(admin.h)).status).toBe(422);
    expect((await api().get(`${BAUX}/variables`).set(admin.h)).body.data.variables).toEqual(expect.arrayContaining(['bail.loyer', 'locataire.nom']));
  });
});

describe('Modèles WhatsApp', () => {
  let modele;
  beforeAll(async () => {
    const liste = await api().get(WHATSAPP).set(admin.h);
    modele = liste.body.data.templates.find((m) => m.variables.length >= 1);
  });

  test('liste triée par événement', async () => {
    const liste = await api().get(WHATSAPP).set(admin.h);
    const codes = liste.body.data.templates.map((m) => m.event_code);
    expect(codes).toEqual([...codes].sort());
  });

  test('modification cohérente : audit, event_code non modifiable', async () => {
    const avant = modele.meta_template_name;
    const res = await api().patch(`${WHATSAPP}/${modele.id}`).set(admin.h).send({ language_code: 'fr', event_code: 'pirate', meta_template_name: 'modele_test_v3' });
    try {
      expect(res.status).toBe(200);
      expect(res.body.data.template).toMatchObject({ event_code: modele.event_code, language_code: 'fr', meta_template_name: 'modele_test_v3' });
      expect(await compter('audit_logs', "action = 'modele_whatsapp.modification' AND entity_id = :id", { id: modele.id })).toBeGreaterThanOrEqual(1);
    } finally {
      await api().patch(`${WHATSAPP}/${modele.id}`).set(admin.h).send({ meta_template_name: avant, language_code: modele.language_code });
    }
  });

  test.each([
    ['corps vide', {}],
    ['nom Meta avec majuscules', { meta_template_name: 'Rappel' }],
    ['langue invalide', { language_code: 'francais' }],
    ['variable avec chiffres', { variables: ['montant1'] }],
    ['11 variables', { variables: Array.from({ length: 11 }, () => 'montant') }],
    ['aperçu de 1025 caractères', { body_preview: 'a'.repeat(1025) }],
    ['actif non booléen', { is_active: 'oui-oui' }],
  ])('validation 422 : %s', async (_l, corps) => {
    expect((await api().patch(`${WHATSAPP}/${modele.id}`).set(admin.h).send(corps)).status).toBe(422);
  });

  test('aperçu incohérent avec les variables : 422 MODELE_INVALIDE ; inconnu 404', async () => {
    const res = await api().patch(`${WHATSAPP}/${modele.id}`).set(admin.h).send({ body_preview: 'Sans paramètre' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MODELE_INVALIDE');
    expect((await api().patch(`${WHATSAPP}/${INCONNU}`).set(admin.h).send({ is_active: false })).status).toBe(404);
  });
});
