'use strict';

const auth = require('../../../modules/auth/validation/auth.validation.js');
const compte = require('../../../modules/compte/validation/compte.validation.js');
const locataire = require('../../../modules/locataire/validation/locataire.validation.js');
const immeuble = require('../../../modules/immeuble/validation/immeuble.validation.js');
const appartement = require('../../../modules/appartement/validation/appartement.validation.js');
const espace = require('../../../modules/espaceLocataire/validation/espaceLocataire.validation.js');
const parametres = require('../../../modules/parametres/validation/parametres.validation.js');
const admin = require('../../../modules/admin/validation/admin.validation.js');

/**
 * Schémas Joi des modules auth, compte, locataire, immeuble, appartement,
 * espace locataire, paramètres et admin — mêmes options que
 * validate.middleware (stripUnknown : l'affectation de masse est impossible).
 */

const OPTIONS = { abortEarly: false, stripUnknown: true, convert: true };
const valider = (schema, valeur) => schema.validate(valeur, OPTIONS);
const MDP = 'MotDePasse1';

describe('auth.validation', () => {
  const inscription = { first_name: 'Awa', last_name: 'Fall', phone: '77 123 45 67', email: 'AWA@TEST.SN', password: MDP, password_confirmation: MDP };

  test('inscription : normalisation et retrait des champs inconnus (role_code, status, owner_id)', () => {
    const { error, value } = valider(auth.inscriptionSchema, { ...inscription, role_code: 'super_admin', status: 'inactif', owner_id: 'x' });
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ phone: '+221771234567', email: 'awa@test.sn' });
    expect(value).not.toHaveProperty('role_code');
    expect(value).not.toHaveProperty('status');
    expect(value).not.toHaveProperty('owner_id');
  });

  test('inscription : confirmation différente, raison sociale trop longue', () => {
    expect(valider(auth.inscriptionSchema, { ...inscription, password_confirmation: 'Autre1234' }).error.message).toMatch(/confirmation/);
    expect(valider(auth.inscriptionSchema, { ...inscription, company_name: 'x'.repeat(151) }).error).toBeDefined();
    expect(valider(auth.inscriptionSchema, { ...inscription, company_name: '' }).error).toBeUndefined();
  });

  test('connexion : identifiant borné, plateforme en liste blanche', () => {
    expect(valider(auth.connexionSchema, { identifiant: 'a@b.sn', password: 'x' }).error).toBeUndefined();
    expect(valider(auth.connexionSchema, { identifiant: 'a'.repeat(255), password: 'x' }).error).toBeDefined();
    expect(valider(auth.connexionSchema, { identifiant: 'a@b.sn', password: 'x', platform: 'symbian' }).error).toBeDefined();
  });

  test('réinitialisation : code à exactement 6 chiffres', () => {
    const base = { identifiant: 'a@b.sn', password: MDP, password_confirmation: MDP };
    expect(valider(auth.reinitialisationSchema, { ...base, code: '012345' }).error).toBeUndefined();
    for (const code of ['12345', '1234567', 'abcdef', '12 345']) expect(valider(auth.reinitialisationSchema, { ...base, code }).error).toBeDefined();
  });

  test('activation : code XOR lien ; code exige le téléphone ; code à 8 chiffres', () => {
    const mdp = { password: MDP, password_confirmation: MDP };
    expect(valider(auth.activationSchema, { ...mdp, code: '01234567', phone: '771234567' }).error).toBeUndefined();
    expect(valider(auth.activationSchema, { ...mdp, token: 'jeton' }).error).toBeUndefined();
    expect(valider(auth.activationSchema, { ...mdp }).error).toBeDefined();
    expect(valider(auth.activationSchema, { ...mdp, token: 'jeton', code: '01234567', phone: '771234567' }).error).toBeDefined();
    expect(valider(auth.activationSchema, { ...mdp, code: '01234567' }).error).toBeDefined();
    expect(valider(auth.activationSchema, { ...mdp, code: '0123456', phone: '771234567' }).error).toBeDefined();
  });

  test('refresh / déconnexion : jeton facultatif, borné', () => {
    expect(valider(auth.refreshSchema, {}).error).toBeUndefined();
    expect(valider(auth.deconnexionSchema, { refresh_token: 'x'.repeat(2049) }).error).toBeDefined();
  });
});

describe('compte.validation', () => {
  test('profil : au moins un champ de profil ; le mot de passe actuel seul ne suffit pas', () => {
    expect(valider(compte.profilSchema, {}).error).toBeDefined();
    expect(valider(compte.profilSchema, { current_password: MDP }).error).toBeDefined();
    expect(valider(compte.profilSchema, { email: 'n@t.sn', current_password: MDP }).error).toBeUndefined();
    expect(valider(compte.profilSchema, { language: 'wo' }).error).toBeDefined();
    const { value } = valider(compte.profilSchema, { first_name: 'A', role_code: 'super_admin', must_change_password: false });
    expect(value).toEqual({ first_name: 'A' });
  });

  test('mot de passe : confirmation, politique, appareil', () => {
    expect(valider(compte.motDePasseSchema, { current_password: 'x', password: MDP, password_confirmation: MDP }).error).toBeUndefined();
    expect(valider(compte.motDePasseSchema, { current_password: 'x', password: 'faible', password_confirmation: 'faible' }).error).toBeDefined();
    expect(valider(compte.appareilSchema, { token: 'x'.repeat(10), platform: 'ios' }).error).toBeUndefined();
    expect(valider(compte.appareilSchema, { token: 'x'.repeat(9), platform: 'ios' }).error).toBeDefined();
  });
});

describe('locataire.validation', () => {
  test('création : consentement et invitation à false par défaut, owner_id / user_id retirés', () => {
    const { error, value } = valider(locataire.creationSchema, { first_name: 'F', last_name: 'S', phone: '771234567', owner_id: 'x', user_id: 'y' });
    expect(error).toBeUndefined();
    expect(value).toEqual({ first_name: 'F', last_name: 'S', phone: '+221771234567', whatsapp_consent: false, send_invitation: false });
  });

  test('pièce d’identité : type en liste blanche, numéro borné ; e-mail vide permis', () => {
    const base = { first_name: 'F', last_name: 'S', phone: '771234567' };
    expect(valider(locataire.creationSchema, { ...base, id_document_type: 'cni', id_document_number: 'x'.repeat(60), email: '' }).error).toBeUndefined();
    expect(valider(locataire.creationSchema, { ...base, id_document_type: 'badge' }).error).toBeDefined();
    expect(valider(locataire.creationSchema, { ...base, id_document_number: 'x'.repeat(61) }).error).toBeDefined();
  });

  test('liste : statut, immeuble UUID, tri en liste blanche', () => {
    expect(valider(locataire.listeSchema, { statut: 'actif', tri: '-created_at' }).error).toBeUndefined();
    expect(valider(locataire.listeSchema, { building_id: "1' OR '1'='1" }).error).toBeDefined();
    expect(valider(locataire.listeSchema, { tri: 'phone' }).error).toBeDefined();
    expect(valider(locataire.modificationSchema, {}).error).toBeDefined();
  });
});

describe('immeuble.validation et appartement.validation', () => {
  test('immeuble : nom 1–150, étages 0–300 entiers', () => {
    const base = { name: 'R', address: 'A', city: 'Dakar' };
    expect(valider(immeuble.creationSchema, { ...base, floors_count: 0 }).error).toBeUndefined();
    expect(valider(immeuble.creationSchema, { ...base, name: 'x'.repeat(150) }).error).toBeUndefined();
    expect(valider(immeuble.creationSchema, { ...base, name: 'x'.repeat(151) }).error).toBeDefined();
    expect(valider(immeuble.creationSchema, { ...base, floors_count: 301 }).error).toBeDefined();
    expect(valider(immeuble.creationSchema, { ...base, owner_id: 'x' }).value).not.toHaveProperty('owner_id');
  });

  test('appartement : statut jamais accepté à la création ; « occupé » refusé au changement manuel', () => {
    const { value } = valider(appartement.creationSchema, { building_id: '3f1c2b9e-1d2a-4c3b-9a8b-7c6d5e4f3a2b', number: '1', type: 'f2', rent_amount: 1, status: 'occupe' });
    expect(value).not.toHaveProperty('status');
    expect(valider(appartement.statutSchema, { status: 'occupe' }).error).toBeDefined();
    expect(valider(appartement.statutSchema, { status: 'en_travaux' }).error).toBeUndefined();
  });

  test('appartement : montants entiers positifs, surface arrondie à 2 décimales, coefficient > 0', () => {
    const base = { building_id: '3f1c2b9e-1d2a-4c3b-9a8b-7c6d5e4f3a2b', number: '1', type: 'f2', rent_amount: 1 };
    expect(valider(appartement.creationSchema, { ...base, rent_amount: -1 }).error).toBeDefined();
    expect(valider(appartement.creationSchema, { ...base, surface: 12.345 }).value.surface).toBe(12.35);
    expect(valider(appartement.creationSchema, { ...base, charge_coefficient: 0 }).error).toBeDefined();
    expect(valider(appartement.rentabiliteSchema, { du: '2026-01-01' }).error).toBeDefined();
  });
});

describe('espace locataire, paramètres, admin', () => {
  test('échéances : ordre par défaut « desc », statut en liste blanche', () => {
    expect(valider(espace.echeancesSchema, {}).value).toEqual({ ordre: 'desc' });
    expect(valider(espace.echeancesSchema, { status: 'gratuit' }).error).toBeDefined();
    expect(valider(espace.consentementSchema, { accorde: true, tenant_id: 'x' }).error).toBeDefined();
  });

  test('paramètres propriétaire : au moins un réglage, clés inconnues retirées', () => {
    expect(valider(parametres.reglagesSchema, {}).error).toBeDefined();
    expect(valider(parametres.reglagesSchema, { late_grace_days: 1, pirate: 1 }).value).toEqual({ late_grace_days: 1 });
    expect(valider(parametres.profilSchema, { display_name: 'A' }).error).toBeDefined();
  });

  test('admin : code de plan mis en majuscules, motif 3–1000 caractères, super admin sans rôle choisi', () => {
    expect(valider(admin.planCreationSchema, { code: 'mon_plan', name: 'P', price: 1 }).value.code).toBe('MON_PLAN');
    expect(valider(admin.motifSchema, { reason: 'ab' }).error).toBeDefined();
    expect(valider(admin.motifSchema, { reason: 'abc' }).error).toBeUndefined();
    const { value } = valider(admin.superAdminSchema, { first_name: 'A', last_name: 'B', email: 'a@b.sn', password: 'x', role_code: 'proprietaire' });
    expect(value).not.toHaveProperty('role_code');
    expect(valider(admin.activationSchema, { plan_code: 'PRO', months: 25 }).error).toBeDefined();
    // Date au bon format mais inexistante : refusée (422) depuis le correctif de
    // `dateIso` — elle était acceptée puis rejetée par PostgreSQL en 500.
    expect(valider(admin.journalSchema, { du: '2026-02-30' }).error).toBeDefined();
    expect(valider(admin.journalSchema, { du: '2026-02-28' }).error).toBeUndefined();
    expect(valider(admin.categorieCreationSchema, { code: 'A-B', name: 'x', cash_group: 'autre' }).error).toBeDefined();
  });
});
