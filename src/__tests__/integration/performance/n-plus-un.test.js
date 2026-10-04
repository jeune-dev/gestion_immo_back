'use strict';

const { listerRoutes } = require('../../../../scripts/lister-routes.js');
const {
  api, superAdmin, creerAppartement, echeancesDu, payerEspeces, pngTest, fermer, sequelize,
} = require('../../setup/helpers.js');
const { jeuComplet, resoudreParametres } = require('../../setup/jeuComplet.js');
const { mesurer, formesEnHausse } = require('../../setup/compteurRequetes.js');
const droits = require('../../../modules/abonnement/service/droits.service.js');

/**
 * DÉTECTION DES N+1 sur TOUTES les routes de lecture de l'API.
 *
 * Une route sans N+1 émet un nombre de requêtes SQL qui ne dépend PAS du
 * volume de données : 1 immeuble ou 40, 1 paiement ou 15, la page coûte le
 * même nombre d'allers-retours vers PostgreSQL. Deux contrôles :
 *
 *   1. PETIT compte (un exemplaire de chaque ressource) contre GROS compte
 *      (le même jeu ×4, plus des enfants supplémentaires sous les ressources
 *      consultées en détail : appartements d'un immeuble, allocations d'un
 *      paiement, photos d'un chantier, messages d'un fil…). Toute route dont
 *      le nombre de requêtes augmente est en échec, avec les requêtes
 *      répétées en cause.
 *   2. Listes paginées : `?limit=1` contre `?limit=100` sur le même compte —
 *      une requête par ligne affichée se voit quel que soit l'historique de
 *      la base (listes de l'administration notamment).
 *
 * Les routes sont lues sur le routeur réel : une route ajoutée demain est
 * contrôlée d'office.
 */

const ROUTES_GET = listerRoutes()
  .filter((r) => r.methode === 'GET' && r.chemin.startsWith('/api/v1/'))
  .map((r) => r.chemin.replace(/\/$/, ''))
  // Vérification d'abonnement Meta (paramètres hub.* imposés), sans base.
  .filter((c) => c !== '/api/v1/webhooks/whatsapp');

function profil(chemin) {
  if (/^\/api\/v1\/(referentiels|abonnement\/plans)(\/|$)/.test(chemin)) return 'public';
  if (chemin.startsWith('/api/v1/locataire/')) return 'locataire';
  if (chemin.startsWith('/api/v1/admin/')) return 'admin';
  return 'proprietaire';
}

/** Passe le compte au plan sans limite d'immeubles ni d'appartements. */
async function planIllimite(ownerId) {
  await sequelize.query(
    "UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = 'PRO') WHERE owner_id = :o",
    { replacements: { o: ownerId } }
  );
  await droits.invalider(ownerId);
}

const verifier = (res, attendu, etape) => {
  if (res.status !== attendu) throw new Error(`${etape} : ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.data;
};

/** Ajoute des ENFANTS sous les ressources du jeu (ce que les routes de détail affichent). */
async function enfantsSupplementaires(jeu, n) {
  const { proprio: p, locataire: loc, ids } = jeu;
  const png = await pngTest('#0a0');
  for (let i = 0; i < n; i += 1) {
    await creerAppartement(p, ids.building);
    verifier(await api().post(`/api/v1/travaux/${ids.workOrder}/photos`).set(p.h).field('phase', 'pendant').attach('fichier', png, 'p.png'), 201, 'photo');
    verifier(await api().post(`/api/v1/messagerie/locataires/${ids.tenant}/messages`).set(p.h).send({ body: `Message ${i}` }), 201, 'message propriétaire');
    verifier(await api().post(`/api/v1/locataire/messagerie/${ids.thread}/messages`).set(loc.h).send({ body: `Réponse ${i}` }), 201, 'message locataire');
    verifier(await api().post('/api/v1/locataire/incidents').set(loc.h).send({ category: 'panne_electrique', title: `Panne ${i}`, description: 'Prise HS' }), 201, 'incident');
    verifier(await api().post('/api/v1/documents').set(p.h)
      .field('entity_type', 'building').field('entity_id', ids.building).field('category', 'photo').attach('fichier', png, `d${i}.png`), 201, 'document');
  }
  // Un paiement qui solde PLUSIEURS échéances : son détail liste ses allocations.
  const ouvertes = (await echeancesDu(p, ids.lease)).filter((e) => e.status !== 'payee' && e.id !== ids.schedule);
  const montant = ouvertes.slice(0, n).reduce((s, e) => s + Number(e.amount_due), 0);
  const gros = await payerEspeces(p, ids.lease, montant);
  return { ...ids, payment: gros.payment.id };
}

/** Mesure une route (appel d'échauffement puis appel compté : caches identiques). */
async function compter(url, h) {
  const appel = () => (h ? api().get(url).set(h) : api().get(url));
  await appel();
  const m = await mesurer(appel);
  return { ...m, status: m.resultat.status, pagination: m.resultat.body?.data?.pagination };
}

describe('Performance : aucune requête SQL par ligne (N+1)', () => {
  let petit;
  let gros;
  let admin;
  const profils = {};
  const mesures = {};

  // Paramètres obligatoires de certaines lectures (période d'un rapport…).
  const PERIODE = 'du=2026-01-01&au=2026-12-31';
  const requete = (chemin, jeu) => ({
    '/api/v1/appartements/:id/rentabilite': PERIODE,
    '/api/v1/caisse/synthese': PERIODE,
    '/api/v1/rapports/financier': PERIODE,
    '/api/v1/rapports/immobilier': PERIODE,
    '/api/v1/rapports/travaux': PERIODE,
    '/api/v1/rapports/locataires': PERIODE,
    '/api/v1/rapports/rentabilite': PERIODE,
    '/api/v1/etats-des-lieux/comparaison': `lease_id=${jeu.ids.lease}`,
    '/api/v1/locataire/paiements/moyens': `lease_id=${jeu.ids.lease}`,
  }[chemin]);

  const urlDe = (chemin, jeu) => {
    let url = chemin;
    if (chemin.startsWith('/api/v1/admin/')) {
      url = chemin.replace(':id', {
        proprietaires: jeu.proprio.ownerId,
        abonnements: jeu.abonnement,
        utilisateurs: jeu.proprio.user.id,
        plans: jeu.plan,
        'modeles-bail': jeu.modeleBail,
      }[chemin.split('/')[4]]);
    } else if (chemin === '/api/v1/factures-communes/:id/apercu') {
      url = chemin.replace(':id', jeu.factureARepartir); // une facture répartie n'a plus d'aperçu (409)
    } else if (chemin.startsWith('/api/v1/locataire/etats-des-lieux/:id')) {
      url = chemin.replace(':id', jeu.edlLocataire); // celui du jeu concerne un autre bail
    } else if (chemin.includes(':')) {
      url = resoudreParametres(chemin, jeu.ids);
    }
    const q = requete(chemin, jeu);
    return url && q ? `${url}?${q}` : url;
  };

  beforeAll(async () => {
    admin = await superAdmin();
    const [[plan]] = await sequelize.query("SELECT id FROM subscription_plans WHERE code = 'PRO'");
    const [[modele]] = await sequelize.query('SELECT id FROM lease_templates ORDER BY created_at LIMIT 1');
    const complement = async (jeu) => {
      const [[abo]] = await sequelize.query('SELECT id FROM subscriptions WHERE owner_id = :o LIMIT 1', { replacements: { o: jeu.proprio.ownerId } });
      const { proprio: p, ids } = jeu;
      // Facture commune pas encore répartie (aperçu de la répartition).
      const facture = verifier(await api().post('/api/v1/factures-communes').set(p.h).send({
        building_id: ids.building, charge_type: 'eau', supplier: 'SEN EAU', invoice_number: `E-${Date.now()}`,
        period_start: '2026-09-01', period_end: '2026-09-30', amount: 30000, allocation_method: 'egale',
      }), 201, 'facture à répartir');
      // État des lieux du bail du LOCATAIRE, soumis : il le consulte dans son espace.
      const edl = verifier(await api().post('/api/v1/etats-des-lieux').set(p.h).send({ lease_id: ids.lease, type: 'sortie' }), 201, 'état des lieux locataire').inspection;
      const items = verifier(await api().get(`/api/v1/etats-des-lieux/${edl.id}`).set(p.h), 200, 'détail EDL').inspection.rooms.flatMap((r) => r.items);
      verifier(await api().put(`/api/v1/etats-des-lieux/${edl.id}/saisie`).set(p.h).send({ items: items.map((i) => ({ item_id: i.id, condition: 'bon' })) }), 200, 'saisie EDL');
      verifier(await api().post(`/api/v1/etats-des-lieux/${edl.id}/soumettre`).set(p.h), 200, 'soumission EDL');
      // Et un état des lieux d'entrée : la comparaison entrée / sortie exige les deux.
      verifier(await api().post('/api/v1/etats-des-lieux').set(p.h).send({ lease_id: ids.lease, type: 'entree' }), 201, 'EDL entrée');
      return {
        ...jeu, abonnement: abo.id, plan: plan.id, modeleBail: modele?.id,
        factureARepartir: (facture.invoice || facture.charge_invoice || Object.values(facture)[0]).id, edlLocataire: edl.id,
      };
    };

    // PETIT compte, mesuré AVANT que le gros n'existe (routes d'administration comprises).
    petit = await complement(await jeuComplet());
    profils.petit = { public: null, proprietaire: petit.proprio.h, locataire: petit.locataire.h, admin: admin.h };
    mesures.petit = {};
    for (const chemin of ROUTES_GET) {
      const url = urlDe(chemin, petit);
      if (url) mesures.petit[chemin] = await compter(url, profils.petit[profil(chemin)]);
    }

    // GROS compte : le jeu complet ×4 sur le même propriétaire, plus des enfants.
    gros = await complement(await jeuComplet());
    await planIllimite(gros.proprio.ownerId);
    for (let i = 0; i < 3; i += 1) await jeuComplet({ proprio: gros.proprio });
    gros.ids = await enfantsSupplementaires(gros, 4);
    profils.gros = { public: null, proprietaire: gros.proprio.h, locataire: gros.locataire.h, admin: admin.h };
    mesures.gros = {};
    for (const chemin of ROUTES_GET) {
      const url = urlDe(chemin, gros);
      if (url) mesures.gros[chemin] = await compter(url, profils.gros[profil(chemin)]);
    }
  }, 900000);

  afterAll(async () => {
    if (process.env.PERF_DETAIL) {
      const lignes = ROUTES_GET.map((c) => `${String(mesures.petit[c]?.total).padStart(3)} ${String(mesures.gros[c]?.total).padStart(3)}  ${c}`);
      process.stdout.write(`\nRequêtes SQL par route (petit / gros compte)\n${lignes.join('\n')}\n`);
    }
    await fermer();
  });

  test('le détecteur voit un N+1 volontaire (contrôle du contrôle)', async () => {
    const parLigne = (n) => async () => {
      const [lignes] = await sequelize.query('SELECT id FROM subscription_plans ORDER BY id LIMIT :n', { replacements: { n } });
      for (const l of lignes) await sequelize.query('SELECT name FROM subscription_plans WHERE id = :id', { replacements: { id: l.id } });
    };
    const un = await mesurer(parLigne(1));
    const trois = await mesurer(parLigne(3));
    expect(trois.total - un.total).toBe(2);
    expect(formesEnHausse(un, trois)).toEqual([expect.stringMatching(/^1 → 3 × SELECT name FROM "?subscription_plans"? WHERE id = \?/)]);
  });

  test('chaque route de lecture est mesurée sur les deux comptes, avec succès', () => {
    const fautes = ROUTES_GET
      .filter((c) => !mesures.petit[c] || !mesures.gros[c]
        || mesures.petit[c].status >= 300 || mesures.gros[c].status >= 300)
      .map((c) => `${c} : ${mesures.petit[c]?.status ?? 'non résolue'} / ${mesures.gros[c]?.status ?? 'non résolue'}`);
    expect(fautes).toEqual([]);
    expect(ROUTES_GET.length).toBeGreaterThan(100);
  });

  test('le gros compte contient vraiment plus de données (le contrôle a du sens)', async () => {
    const total = async (url, h) => (await api().get(url).set(h)).body.data.pagination.total;
    for (const url of ['/api/v1/immeubles', '/api/v1/appartements', '/api/v1/paiements', '/api/v1/travaux', '/api/v1/documents']) {
      const [a, b] = [await total(url, petit.proprio.h), await total(url, gros.proprio.h)];
      expect(b).toBeGreaterThanOrEqual(a * 3);
    }
    expect(await total('/api/v1/locataire/incidents', gros.locataire.h)).toBeGreaterThanOrEqual(5);
  });

  test('aucune route ne fait plus de requêtes SQL quand les données se multiplient', () => {
    const fautes = [];
    for (const chemin of ROUTES_GET) {
      const a = mesures.petit[chemin];
      const b = mesures.gros[chemin];
      if (!a || !b || a.status >= 300 || b.status >= 300) continue;
      if (b.total > a.total) fautes.push(`${chemin} : ${a.total} → ${b.total} requêtes\n    ${formesEnHausse(a, b).join('\n    ')}`);
    }
    expect(fautes).toEqual([]);
  });

  test('listes paginées : une page de 100 lignes coûte autant qu’une page d’une ligne', async () => {
    const fautes = [];
    let controlees = 0;
    for (const chemin of ROUTES_GET.filter((c) => !c.includes(':'))) {
      const b = mesures.gros[chemin];
      if (!b?.pagination || b.pagination.total < 3) continue;
      const h = profils.gros[profil(chemin)];
      const sep = chemin.includes('?') ? '&' : '?';
      const une = await compter(`${chemin}${sep}limit=1`, h);
      const cent = await compter(`${chemin}${sep}limit=100`, h);
      controlees += 1;
      if (cent.total > une.total) fautes.push(`${chemin} : ${une.total} → ${cent.total} requêtes\n    ${formesEnHausse(une, cent).join('\n    ')}`);
    }
    expect(fautes).toEqual([]);
    expect(controlees).toBeGreaterThanOrEqual(25);
  }, 120000);

  test('budget de requêtes : aucune lecture ne dépasse 25 allers-retours SQL', () => {
    const lourdes = Object.entries(mesures.gros)
      .filter(([, m]) => m.total > 25)
      .map(([c, m]) => `${c} : ${m.total}`);
    expect(lourdes).toEqual([]);
  });
});
