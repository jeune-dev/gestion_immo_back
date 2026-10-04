'use strict';

/**
 * Jeu de données COMPLET d'un propriétaire : au moins une ressource de chaque
 * type exposé par l'API, créée par les vraies routes (mêmes chemins que le
 * mobile). Sert aux matrices de sécurité : un autre propriétaire (ou un autre
 * locataire) essaie chaque route paramétrée avec ces identifiants.
 */
const {
  api, nouveauProprietaire, bailActif, activerLocataire, echeancesDu, payerEspeces, pngTest, sequelize,
} = require('./helpers.js');

const verifier = (res, attendu, etape) => {
  if (res.status !== attendu) throw new Error(`${etape} : ${res.status} ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body.data;
};

/**
 * @param {object} [options]
 * @param {object} [options.proprio] propriétaire existant : le jeu lui AJOUTE
 *   un exemplaire de chaque ressource (mesure du nombre de requêtes SQL quand
 *   les données d'un compte se multiplient — détection des N+1).
 */
async function jeuComplet({ proprio } = {}) {
  const p = proprio || await nouveauProprietaire();
  const png = await pngTest();

  // Patrimoine, bail actif, locataire activé, échéances, paiement + quittance.
  const bail = await bailActif(p);
  const loc = await activerLocataire(p, bail.tenant);
  const [echeance, echeance2] = await echeancesDu(p, bail.lease.id);
  const paiement = await payerEspeces(p, bail.lease.id, echeance.amount_due, { scheduleId: echeance.id });

  // Caution d'un second bail, terminé : versement, justificatif, retenue.
  const bail2 = await bailActif(p);
  const [[{ id: depositId }]] = await sequelize.query('SELECT id FROM deposits WHERE lease_id = :l', { replacements: { l: bail2.lease.id } });
  verifier(await api().post(`/api/v1/cautions/${depositId}/versements`).set(p.h).send({ amount: 700000, occurred_on: '2026-09-01', method: 'especes' }), 201, 'versement');
  verifier(await api().post(`/api/v1/baux/${bail2.lease.id}/terminer`).set(p.h).send({ ended_on: '2026-10-31' }), 200, 'fin de bail');
  const justif = verifier(await api().post(`/api/v1/cautions/${depositId}/justificatifs`).set(p.h).attach('fichier', png, 'j.png'), 201, 'justificatif');
  const retenue = verifier(await api().post(`/api/v1/cautions/${depositId}/retenues`).set(p.h)
    .send({ amount: 10000, reason: 'degradation', description: 'Vitre cassée', justification_document_ids: [justif.document.id] }), 201, 'retenue');

  // Opérations : artisan, travaux + photo, dépense, catégorie, caisse.
  const artisan = verifier(await api().post('/api/v1/artisans').set(p.h).send({ name: 'Mamadou Diop', trade: 'plombier', phone: '+221770001122' }), 201, 'artisan');
  const artisanId = (artisan.contractor || artisan.artisan || Object.values(artisan)[0]).id;
  const travail = verifier(await api().post('/api/v1/travaux').set(p.h)
    .send({ title: 'Fuite', category: 'plomberie', building_id: bail.building.id, apartment_id: bail.apartment.id }), 201, 'travaux');
  const travailId = (travail.work_order || Object.values(travail)[0]).id;
  const photo = verifier(await api().post(`/api/v1/travaux/${travailId}/photos`).set(p.h).field('phase', 'avant').attach('fichier', png, 'p.png'), 201, 'photo travaux');
  const photoTravauxId = (photo.photo || photo.work_photo || Object.values(photo)[0]).id;
  const [[categorie]] = await sequelize.query("SELECT id FROM expense_categories WHERE owner_id IS NULL AND code = 'travaux'");
  const depense = verifier(await api().post('/api/v1/depenses').set(p.h)
    .send({ amount: 100000, category_id: categorie.id, method: 'especes', spent_on: '2026-09-23', building_id: bail.building.id, apartment_id: bail.apartment.id, description: 'Plomberie' }), 201, 'dépense');
  const depenseId = (depense.expense || Object.values(depense)[0]).id;
  const cat = verifier(await api().post('/api/v1/categories-depenses').set(p.h).send({ name: `Jardinage ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, cash_group: 'entretien' }), 201, 'catégorie');
  const categorieId = (cat.category || Object.values(cat)[0]).id;
  const revenu = verifier(await api().post('/api/v1/caisse/autres-revenus').set(p.h)
    .send({ amount: 5000, method: 'especes', occurred_on: '2026-09-10', label: 'Location parking' }), 201, 'autre revenu');

  // Facture commune répartie → charge refacturée.
  const facture = verifier(await api().post('/api/v1/factures-communes').set(p.h).send({
    building_id: bail.building.id, charge_type: 'electricite', supplier: 'SENELEC', invoice_number: `F-${Date.now()}`,
    period_start: '2026-09-01', period_end: '2026-09-30', amount: 60000, allocation_method: 'egale',
  }), 201, 'facture');
  const factureId = (facture.invoice || facture.charge_invoice || Object.values(facture)[0]).id;
  verifier(await api().post(`/api/v1/factures-communes/${factureId}/repartir`).set(p.h).send({}), 200, 'répartition');
  const [[charge]] = await sequelize.query('SELECT id FROM charges WHERE charge_invoice_id = :f', { replacements: { f: factureId } });

  // Incident signalé par le locataire, état des lieux, messagerie, document.
  const incident = verifier(await api().post('/api/v1/locataire/incidents').set(loc.h)
    .send({ category: 'fuite', title: 'Fuite cuisine', description: 'Fuite sous l’évier' }), 201, 'incident');
  const incidentId = (incident.incident || Object.values(incident)[0]).id;
  const edl = verifier(await api().post('/api/v1/etats-des-lieux').set(p.h).send({ lease_id: bail2.lease.id, type: 'sortie' }), 201, 'état des lieux');
  const inspection = edl.inspection || Object.values(edl)[0];
  const [[piece]] = await sequelize.query('SELECT r.id AS room_id, i.id AS item_id FROM inspection_rooms r JOIN inspection_items i ON i.room_id = r.id WHERE r.inspection_id = :id LIMIT 1', { replacements: { id: inspection.id } });
  const photoEdl = verifier(await api().post(`/api/v1/etats-des-lieux/${inspection.id}/elements/${piece.item_id}/photos`).set(p.h).attach('fichier', png, 'e.png'), 201, 'photo état des lieux');
  const photoEdlId = (photoEdl.photo || Object.values(photoEdl)[0]).id;
  verifier(await api().post(`/api/v1/messagerie/locataires/${bail.tenant.id}/messages`).set(p.h).send({ body: 'Bonjour' }), 201, 'message');
  const [[fil]] = await sequelize.query('SELECT id FROM message_threads WHERE tenant_id = :t', { replacements: { t: bail.tenant.id } });
  const doc = verifier(await api().post('/api/v1/documents').set(p.h)
    .field('entity_type', 'building').field('entity_id', bail.building.id).field('category', 'photo').attach('fichier', png, 'b.png'), 201, 'document');
  const documentId = (doc.document || Object.values(doc)[0]).id;

  // Transaction (preuve de paiement direct) et entrée de rapprochement.
  verifier(await api().put('/api/v1/paiements/moyens').set(p.h).send({ provider: 'wave', mode: 'preuve', account_number: '771234567' }), 200, 'moyen');
  const preuve = verifier(await api().post('/api/v1/locataire/paiements/preuves').set(loc.h)
    .send({ rent_schedule_id: echeance2.id, wallet: 'wave', provider_transaction_id: `WV-${Date.now()}`, amount: 1000 }), 201, 'preuve');
  const [[entree]] = await sequelize.query(
    "INSERT INTO reconciliation_entries (owner_id, type, amount, details) VALUES (:o, 'non_identifie', 1234, '{}'::jsonb) RETURNING id",
    { replacements: { o: p.ownerId } }
  );
  const [[notif]] = await sequelize.query('SELECT id FROM notifications WHERE user_id = :u LIMIT 1', { replacements: { u: loc.user.id } });
  const [[session]] = await sequelize.query('SELECT id FROM refresh_tokens WHERE user_id = :u AND revoked_at IS NULL LIMIT 1', { replacements: { u: p.user.id } });
  const [[recu]] = await sequelize.query('SELECT id FROM receipts WHERE rent_schedule_id = :e', { replacements: { e: echeance.id } });
  const [[mouvement]] = await sequelize.query("SELECT id FROM cash_movements WHERE owner_id = :o AND source_type = 'manuel' LIMIT 1", { replacements: { o: p.ownerId } });

  return {
    proprio: p,
    locataire: loc,
    ids: {
      building: bail.building.id,
      apartment: bail.apartment.id,
      tenant: bail.tenant.id,
      lease: bail.lease.id,
      schedule: echeance.id,
      payment: paiement.payment.id,
      receipt: recu.id,
      deposit: depositId,
      depositTransaction: retenue.transaction.id,
      contractor: artisanId,
      workOrder: travailId,
      workPhoto: photoTravauxId,
      expense: depenseId,
      category: categorieId,
      cashMovement: mouvement?.id || revenu.movement.id,
      invoice: factureId,
      charge: charge.id,
      incident: incidentId,
      inspection: inspection.id,
      room: piece.room_id,
      item: piece.item_id,
      inspectionPhoto: photoEdlId,
      thread: fil.id,
      document: documentId,
      transaction: preuve.transaction.id,
      reconciliation: entree.id,
      notification: notif?.id,
      session: session?.id,
    },
  };
}

/**
 * Identifiant à utiliser pour chaque paramètre d'une route, déduit du segment
 * qui le précède. Retourne null si la route n'est pas couverte (le test échoue
 * alors en listant la route : aucune route paramétrée ne peut être oubliée).
 */
function resoudreParametres(chemin, ids) {
  const segments = chemin.split('/');
  const valeurs = {};
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    if (!s.startsWith(':')) continue;
    const avant = segments[i - 1];
    const avantAvant = segments[i - 2];
    const cle = `${avantAvant || ''}/${avant}/${s}`;
    const table = {
      'v1/immeubles/:id': ids.building,
      'v1/appartements/:id': ids.apartment,
      'v1/locataires/:id': ids.tenant,
      'v1/baux/:id': ids.lease,
      'v1/echeances/:id': ids.schedule,
      'v1/paiements/:id': ids.payment,
      'paiements/transactions/:id': ids.transaction,
      'paiements/rapprochements/:id': ids.reconciliation,
      'v1/quittances/:id': ids.receipt,
      'v1/factures-communes/:id': ids.invoice,
      'v1/charges/:id': ids.charge,
      'v1/depenses/:id': ids.expense,
      'v1/categories-depenses/:id': ids.category,
      'v1/caisse/:id': ids.cashMovement,
      'v1/travaux/:id': ids.workOrder,
      ':id/photos/:photoId': chemin.includes('/travaux/') ? ids.workPhoto : ids.inspectionPhoto,
      'v1/artisans/:id': ids.contractor,
      'v1/incidents/:id': ids.incident,
      'v1/etats-des-lieux/:id': ids.inspection,
      ':id/pieces/:roomId': ids.room,
      ':id/elements/:itemId': ids.item,
      'v1/cautions/:id': ids.deposit,
      ':id/retenues/:transactionId': ids.depositTransaction,
      'caution/retenues/:transactionId': ids.depositTransaction,
      'messagerie/fils/:id': ids.thread,
      'messagerie/locataires/:tenantId': ids.tenant,
      'v1/documents/:id': ids.document,
      'v1/notifications/:id': ids.notification,
      'compte/sessions/:id': ids.session,
      'locataire/echeances/:id': ids.schedule,
      'locataire/charges/:id': ids.charge,
      'locataire/incidents/:id': ids.incident,
      'locataire/etats-des-lieux/:id': ids.inspection,
      'locataire/messagerie/:threadId': ids.thread,
      'locataire/quittances/:id': ids.receipt,
      'paiements/transactions/:id#locataire': ids.transaction,
    };
    const valeur = table[cle] ?? (cle === 'paiements/transactions/:id' ? ids.transaction : undefined);
    if (!valeur) return null;
    valeurs[s] = valeur;
  }
  return chemin.replace(/:[A-Za-z]+/g, (p) => valeurs[p]);
}

module.exports = { jeuComplet, resoudreParametres };
