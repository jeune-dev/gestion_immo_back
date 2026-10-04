'use strict';

const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const { Tenant, Lease, Apartment, Building, Owner, Deposit, TenantInvitation } = require('../../../models/index.js');
const { chargerPourProprietaire } = require('../../../utils/acces.js');
const { ordre, rechercheTexte } = require('../../../utils/liste.js');
const { ConflictError } = require('../../../errors/AppError.js');
const invitations = require('../../auth/service/invitation.service.js');
const documents = require('../../document/service/document.service.js');
const email = require('../../../infrastructure/email.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');
const logger = require('../../../utils/logger.js');

/**
 * Locataires (§ 9) : identité, contact, pièce d'identité (numéro chiffré),
 * baux (appartement, dates d'entrée et de sortie, loyer, caution, contrat) et
 * historique des paiements — « le propriétaire doit pouvoir consulter
 * rapidement tout ce qui concerne ce locataire ».
 */

const CHAMPS = ['first_name', 'last_name', 'phone', 'email', 'id_document_type', 'id_document_number', 'notes'];
const ATTRIBUTS_LISTE = ['id', 'first_name', 'last_name', 'phone', 'email', 'user_id', 'whatsapp_consent', 'created_at'];

/** Filtre de statut calculé à partir des baux (sous-requêtes indexées). */
const CONDITION_STATUT = {
  actif: sequelize.literal('EXISTS (SELECT 1 FROM leases l WHERE l.tenant_id = "Tenant"."id" AND l.status = \'actif\')'),
  ancien: sequelize.literal('NOT EXISTS (SELECT 1 FROM leases l WHERE l.tenant_id = "Tenant"."id" AND l.status = \'actif\') AND EXISTS (SELECT 1 FROM leases l WHERE l.tenant_id = "Tenant"."id" AND l.status IN (\'termine\', \'clos\'))'),
  sans_bail: sequelize.literal('NOT EXISTS (SELECT 1 FROM leases l WHERE l.tenant_id = "Tenant"."id" AND l.status IN (\'actif\', \'termine\', \'clos\'))'),
};

async function lister(ownerId, filtres, { limit, offset }) {
  const et = [{ owner_id: ownerId }];
  const texte = rechercheTexte(filtres.q, ['first_name', 'last_name', 'phone', 'email']);
  if (texte) et.push(texte);
  if (filtres.statut) et.push(CONDITION_STATUT[filtres.statut]);
  if (filtres.building_id) {
    et.push(sequelize.literal(`EXISTS (SELECT 1 FROM leases l JOIN apartments a ON a.id = l.apartment_id WHERE l.tenant_id = "Tenant"."id" AND a.building_id = ${sequelize.escape(filtres.building_id)})`));
  }

  const { rows, count } = await Tenant.findAndCountAll({
    where: { [Op.and]: et },
    attributes: ATTRIBUTS_LISTE,
    include: [{
      model: Lease,
      as: 'leases',
      required: false,
      where: { status: 'actif' },
      attributes: ['id', 'reference', 'rent_amount', 'start_date'],
      include: [{ model: Apartment, as: 'apartment', attributes: ['id', 'number'], include: [{ model: Building, as: 'building', attributes: ['id', 'name'] }] }],
    }],
    order: ordre(filtres.tri, 'last_name'),
    limit,
    offset,
    distinct: true,
  });
  return {
    count,
    rows: rows.map((t) => {
      const brut = t.toJSON();
      const bail = brut.leases?.[0] || null;
      delete brut.leases;
      return { ...brut, account_active: Boolean(brut.user_id), current_lease: bail };
    }),
  };
}

/**
 * Fiche complète du locataire : identité, baux (avec appartement et caution),
 * soldes, derniers paiements et documents — 4 requêtes au total, quel que soit
 * le nombre de baux.
 */
async function fiche(id, ownerId) {
  const tenant = await chargerPourProprietaire(Tenant, id, ownerId, {}, 'Locataire');
  const [baux, soldes, paiements, pieces, invitation] = await Promise.all([
    Lease.findAll({
      where: { tenant_id: id },
      include: [
        { model: Apartment, as: 'apartment', attributes: ['id', 'number', 'floor', 'type'], include: [{ model: Building, as: 'building', attributes: ['id', 'name'] }], paranoid: false },
        { model: Deposit, as: 'deposit', attributes: ['id', 'amount_expected', 'amount_received', 'amount_withheld', 'amount_refunded', 'status'] },
      ],
      order: [['start_date', 'DESC']],
    }),
    sequelize.query(`
      SELECT COALESCE(sum(amount_due - amount_paid) FILTER (WHERE status IN ('a_payer', 'partiellement_paye', 'en_retard')), 0) AS reste_du,
             COALESCE(sum(amount_due - amount_paid) FILTER (WHERE status = 'en_retard' OR (status = 'partiellement_paye' AND due_date < CURRENT_DATE)), 0) AS impayes,
             count(*) FILTER (WHERE status = 'en_retard') AS echeances_en_retard
        FROM rent_schedules WHERE tenant_id = :id`, { replacements: { id }, type: QueryTypes.SELECT }),
    sequelize.query(`
      SELECT id, reference, amount, method, paid_on, status FROM rent_payments
       WHERE tenant_id = :id ORDER BY paid_on DESC, created_at DESC LIMIT 12`, { replacements: { id }, type: QueryTypes.SELECT }),
    documents.listerPourEntite('tenant', id),
    TenantInvitation.findOne({ where: { tenant_id: id, used_at: null, revoked_at: null, expires_at: { [Op.gt]: new Date() } }, attributes: ['expires_at', 'created_at'], order: [['created_at', 'DESC']] }),
  ]);

  return {
    ...tenant.toJSON(),
    account_active: Boolean(tenant.user_id),
    pending_invitation: invitation ? { expires_at: invitation.expires_at, created_at: invitation.created_at } : null,
    leases: baux,
    balance: soldes[0],
    recent_payments: paiements,
    documents: pieces.map(documents.versApi),
  };
}

async function verifierTelephoneLibre(ownerId, phone, exclureId, transaction) {
  const where = { owner_id: ownerId, phone };
  if (exclureId) where.id = { [Op.ne]: exclureId };
  if (await Tenant.count({ where, transaction })) {
    throw new ConflictError('Un locataire avec ce numéro existe déjà dans votre patrimoine', 'LOCATAIRE_EXISTANT');
  }
}

async function creer(ownerId, user, donnees) {
  const { send_invitation: inviter, whatsapp_consent: consentement, ...champs } = donnees;
  const resultat = await sequelize.transaction(async (t) => {
    await verifierTelephoneLibre(ownerId, champs.phone, null, t);
    const tenant = await Tenant.create({
      ...champs,
      email: champs.email || null,
      owner_id: ownerId,
      created_by: user.id,
      whatsapp_consent: Boolean(consentement),
      whatsapp_consent_at: consentement ? new Date() : null,
    }, { transaction: t });
    await journaliser({ action: 'locataire.creation', entityType: 'tenant', entityId: tenant.id, ownerId, details: { nom: `${tenant.first_name} ${tenant.last_name}`, whatsapp_consent: Boolean(consentement) } }, t);
    const invitation = inviter ? await invitations.creer(tenant, user.id, t) : null;
    return { tenant, invitation };
  });
  if (resultat.invitation) await envoyerInvitation(ownerId, resultat.tenant, resultat.invitation);
  return resultat;
}

async function modifier(id, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const tenant = await chargerPourProprietaire(Tenant, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Locataire');
    if (donnees.phone && donnees.phone !== tenant.phone) {
      if (tenant.user_id) throw new ConflictError('Le téléphone est l’identifiant de connexion du locataire : il le modifie depuis son compte.', 'TELEPHONE_VERROUILLE');
      await verifierTelephoneLibre(ownerId, donnees.phone, id, t);
    }
    const avant = tenant.toJSON();
    await tenant.update({ ...donnees, email: donnees.email === '' ? null : donnees.email }, { transaction: t, fields: CHAMPS });
    const diff = difference(avant, donnees, CHAMPS);
    if (diff.id_document_number) diff.id_document_number = { avant: '[masqué]', apres: '[masqué]' };
    await journaliser({ action: 'locataire.modification', entityType: 'tenant', entityId: id, ownerId, details: diff }, t);
    return tenant;
  });
}

/** Suppression logique, refusée si le locataire a un bail actif ou un historique financier. */
async function supprimer(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const tenant = await chargerPourProprietaire(Tenant, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Locataire');
    const baux = await Lease.count({ where: { tenant_id: id, status: { [Op.in]: ['actif', 'termine', 'clos'] } }, transaction: t });
    if (baux) throw new ConflictError('Ce locataire a un historique de bail : sa fiche est conservée (§ 42).', 'LOCATAIRE_AVEC_HISTORIQUE');
    await tenant.destroy({ transaction: t });
    await journaliser({ action: 'locataire.suppression', entityType: 'tenant', entityId: id, ownerId }, t);
  });
}

/**
 * Invitation (§ 5 option A) : code + lien d'activation. Le code est RENVOYÉ au
 * propriétaire, qui peut le transmettre lui-même (oral, SMS) ; il est aussi
 * envoyé par e-mail si le locataire en a un.
 */
async function inviter(id, ownerId, user) {
  const { tenant, invitation } = await sequelize.transaction(async (t) => {
    const fiche = await chargerPourProprietaire(Tenant, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Locataire');
    if (fiche.user_id) throw new ConflictError('Ce locataire a déjà activé son compte', 'DEJA_ACTIVE');
    const inv = await invitations.creer(fiche, user.id, t);
    await journaliser({ action: 'locataire.invitation', entityType: 'tenant', entityId: id, ownerId }, t);
    return { tenant: fiche, invitation: inv };
  });
  const canal = await envoyerInvitation(ownerId, tenant, invitation);
  return { tenant, invitation, canal };
}

async function envoyerInvitation(ownerId, tenant, invitation) {
  if (!tenant.email) return 'manuel';
  try {
    const owner = await Owner.findByPk(ownerId, { attributes: ['display_name'] });
    const base = process.env.APP_PUBLIC_URL;
    const r = await email.envoyerInvitationLocataire({
      email: tenant.email,
      prenom: tenant.first_name,
      proprietaire: owner.display_name,
      code: invitation.code,
      lien: base ? `${base.replace(/\/$/, '')}/activation/${invitation.token}` : null,
      jours: invitation.jours,
    });
    return r.envoye ? 'email' : 'manuel';
  } catch (err) {
    logger.warn('[locataire] Envoi de l’invitation par e-mail impossible', { error: err.message });
    return 'manuel';
  }
}

/**
 * Consentement WhatsApp enregistré par le propriétaire (§ 54.3, § 56.1).
 *
 * Le consentement appartient au LOCATAIRE. Le propriétaire peut :
 *   - le RETIRER à tout moment (moins de messages, jamais un risque) ;
 *   - le DÉCLARER recueilli (à la création de la fiche ou plus tard, papier
 *     signé, accord oral) SEULEMENT si aucun retrait n'a jamais été
 *     enregistré (`whatsapp_consent_revoked_at` nul).
 * Après un retrait — par le locataire depuis son espace, ou par le
 * propriétaire —, seul le locataire peut le redonner
 * (POST /locataire/consentement-whatsapp) : un bailleur ne peut pas passer
 * outre un refus exprimé (« aucun message WhatsApp sans consentement »).
 */
async function consentementWhatsapp(id, ownerId, accorde) {
  return sequelize.transaction(async (t) => {
    const tenant = await chargerPourProprietaire(Tenant, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Locataire');
    if (accorde && tenant.whatsapp_consent_revoked_at) {
      throw new ConflictError(
        'Le consentement WhatsApp a été retiré : seul le locataire peut le redonner depuis son espace.',
        'CONSENTEMENT_RETIRE'
      );
    }
    if (accorde && tenant.whatsapp_consent) return tenant;
    await tenant.update(accorde
      ? { whatsapp_consent: true, whatsapp_consent_at: new Date(), whatsapp_consent_revoked_at: null }
      : { whatsapp_consent: false, whatsapp_consent_revoked_at: new Date() }, { transaction: t });
    await journaliser({ action: 'locataire.consentement_whatsapp', entityType: 'tenant', entityId: id, ownerId, details: { accorde } }, t);
    return tenant;
  });
}

module.exports = { lister, fiche, creer, modifier, supprimer, inviter, consentementWhatsapp };
