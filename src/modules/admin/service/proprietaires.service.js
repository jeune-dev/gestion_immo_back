'use strict';

const { Op, QueryTypes } = require('sequelize');
const sequelize = require('../../../config/db.js');
const {
  Owner, OwnerMember, User, Subscription, SubscriptionPlan, Tenant, Building, Incident, Apartment,
} = require('../../../models/index.js');
const { NotFoundError, ConflictError } = require('../../../errors/AppError.js');
const { ordre, rechercheTexte, periode } = require('../../../utils/liste.js');
const escapeLike = require('../../../utils/escapeLike.js');
const sessions = require('../../auth/service/session.service.js');
const { journaliser } = require('../../audit/service/audit.service.js');
const { notifier, destinatairesProprietaire } = require('../../notification/service/notification.service.js');

/**
 * Administration de la plateforme (§ 30) : propriétaires, locataires,
 * immeubles, signalements — vue TRANSVERSE, tous espaces confondus.
 *
 * Minimisation (§ 32) : l'administrateur voit ce dont il a besoin pour
 * piloter et assister, pas davantage. Aucune pièce d'identité, aucune note
 * privée d'un propriétaire sur son locataire, aucune coordonnée de locataire
 * dans la vue des signalements.
 *
 * Les compteurs par ligne sont des sous-requêtes corrélées indexées, calculées
 * dans la requête de la page (pas de N+1).
 */

const COURANTS = "('essai', 'actif', 'suspendu')";

const ATTRIBUTS_UTILISATEUR = ['id', 'first_name', 'last_name', 'email', 'phone', 'status', 'last_login_at', 'created_at'];

const statsProprietaire = (alias) => [
  [sequelize.literal(`(SELECT count(*)::int FROM buildings b WHERE b.owner_id = "${alias}"."id" AND b.deleted_at IS NULL)`), 'buildings_count'],
  [sequelize.literal(`(SELECT count(*)::int FROM apartments a WHERE a.owner_id = "${alias}"."id" AND a.deleted_at IS NULL)`), 'apartments_count'],
  [sequelize.literal(`(SELECT count(*)::int FROM tenants t WHERE t.owner_id = "${alias}"."id" AND t.deleted_at IS NULL)`), 'tenants_count'],
  [sequelize.literal(`(SELECT s.status FROM subscriptions s WHERE s.owner_id = "${alias}"."id" AND s.status IN ${COURANTS})`), 'subscription_status'],
  [sequelize.literal(`(SELECT p.code FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.owner_id = "${alias}"."id" AND s.status IN ${COURANTS})`), 'plan_code'],
  [sequelize.literal(`(SELECT s.current_period_end FROM subscriptions s WHERE s.owner_id = "${alias}"."id" AND s.status IN ${COURANTS})`), 'current_period_end'],
];

// ── Propriétaires ──────────────────────────────────────────────────────────

async function listerProprietaires(filtres, { limit, offset }) {
  const conditions = [];
  const replacements = {};
  const texte = rechercheTexte(filtres.q, ['display_name', 'company_name', 'phone', 'email']);
  if (texte) conditions.push(texte);
  if (filtres.status) conditions.push({ status: filtres.status });
  if (filtres.plan) {
    conditions.push(sequelize.literal(`"Owner"."id" IN (SELECT s.owner_id FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
      WHERE p.code = :plan AND s.status IN ${COURANTS})`));
    replacements.plan = filtres.plan;
  }
  if (filtres.abonnement === 'aucun') {
    conditions.push(sequelize.literal(`NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.owner_id = "Owner"."id" AND s.status IN ${COURANTS})`));
  } else if (filtres.abonnement) {
    conditions.push(sequelize.literal('"Owner"."id" IN (SELECT s.owner_id FROM subscriptions s WHERE s.status = :statutAbonnement)'));
    replacements.statutAbonnement = filtres.abonnement;
  }

  return Owner.findAndCountAll({
    where: conditions.length ? { [Op.and]: conditions } : {},
    attributes: { exclude: ['settings'], include: statsProprietaire('Owner') },
    include: [{ model: User, as: 'titulaire', attributes: ATTRIBUTS_UTILISATEUR }],
    replacements,
    order: ordre(filtres.tri, '-created_at'),
    limit,
    offset,
  });
}

async function chargerProprietaire(id, options = {}) {
  const owner = await Owner.findByPk(id, options);
  if (!owner) throw new NotFoundError('Propriétaire introuvable');
  return owner;
}

async function detailProprietaire(id) {
  const owner = await chargerProprietaire(id, {
    attributes: { include: statsProprietaire('Owner') },
    include: [{ model: User, as: 'titulaire', attributes: ATTRIBUTS_UTILISATEUR }],
  });
  const [abonnement, membres, [activite]] = await Promise.all([
    Subscription.findOne({
      where: { owner_id: id, status: { [Op.in]: ['essai', 'actif', 'suspendu'] } },
      include: [{ model: SubscriptionPlan, as: 'plan', attributes: ['id', 'code', 'name', 'price', 'billing_period'] }],
    }),
    OwnerMember.findAll({
      where: { owner_id: id },
      attributes: ['id', 'role_code', 'status', 'created_at'],
      include: [{ model: User, as: 'user', attributes: ['id', 'first_name', 'last_name', 'status'] }],
    }),
    sequelize.query(
      `SELECT
         (SELECT count(*)::int FROM apartments WHERE owner_id = :id AND deleted_at IS NULL AND status = 'occupe') AS apartments_occupied,
         (SELECT count(*)::int FROM leases WHERE owner_id = :id AND status = 'actif') AS active_leases,
         (SELECT count(*)::int FROM incidents WHERE owner_id = :id AND status IN ('signale', 'en_analyse', 'travaux_planifies')) AS open_incidents`,
      { replacements: { id }, type: QueryTypes.SELECT }
    ),
  ]);
  const { settings, ...donnees } = owner.toJSON();
  return { ...donnees, settings_customized: Object.keys(settings || {}).length > 0, subscription: abonnement, members: membres, activity: activite };
}

/**
 * Suspension d'un espace propriétaire : `requireProprietaire` refuse toute
 * requête (403 ESPACE_SUSPENDU) et les sessions de tous les membres sont
 * fermées — les jetons en circulation sont périmés immédiatement (§ 32
 * « déconnexion distante »). Les données sont conservées intactes.
 */
async function suspendre(id, { reason }) {
  return sequelize.transaction(async (t) => {
    const owner = await chargerProprietaire(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (owner.status === 'suspendu') throw new ConflictError('Cet espace propriétaire est déjà suspendu.', 'DEJA_SUSPENDU');
    await owner.update({ status: 'suspendu' }, { transaction: t });
    const membres = await OwnerMember.findAll({ where: { owner_id: id }, attributes: ['user_id'], transaction: t });
    for (const m of membres) await sessions.revoquerToutesLesSessions(m.user_id, t);
    await journaliser({
      action: 'proprietaire.changement_statut', entityType: 'owner', entityId: id, ownerId: id,
      details: { de: 'actif', a: 'suspendu', motif: reason, sessions_fermees: membres.length },
    }, t);
    return owner;
  });
}

async function reactiver(id) {
  return sequelize.transaction(async (t) => {
    const owner = await chargerProprietaire(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (owner.status === 'actif') throw new ConflictError("Cet espace propriétaire n'est pas suspendu.", 'NON_SUSPENDU');
    await owner.update({ status: 'actif' }, { transaction: t });
    await journaliser({
      action: 'proprietaire.changement_statut', entityType: 'owner', entityId: id, ownerId: id,
      details: { de: 'suspendu', a: 'actif' },
    }, t);
    await notifier(t, {
      destinataires: await destinatairesProprietaire(id, t),
      ownerId: id,
      type: 'systeme',
      titre: 'Espace réactivé',
      corps: 'Votre espace propriétaire a été réactivé. Vous pouvez de nouveau gérer vos biens.',
    });
    return owner;
  });
}

// ── Locataires (vue minimale) ──────────────────────────────────────────────

async function listerLocataires(filtres, { limit, offset }) {
  const conditions = [];
  if (filtres.owner_id) conditions.push({ owner_id: filtres.owner_id });
  if (filtres.q) {
    // Nom complet compris (« Mamadou Ndiaye ») : même expression que l'index
    // trigramme tenants_nom_trgm_idx.
    const motif = `%${escapeLike(filtres.q)}%`;
    conditions.push({
      [Op.or]: [
        { first_name: { [Op.iLike]: motif } },
        { last_name: { [Op.iLike]: motif } },
        { phone: { [Op.iLike]: motif } },
        sequelize.where(sequelize.literal(`("Tenant"."first_name" || ' ' || "Tenant"."last_name")`), { [Op.iLike]: motif }),
      ],
    });
  }
  return Tenant.findAndCountAll({
    where: conditions.length ? { [Op.and]: conditions } : {},
    // Ni pièce d'identité, ni notes, ni e-mail : ce n'est pas nécessaire à
    // l'administration de la plateforme (§ 32).
    attributes: [
      'id', 'owner_id', 'first_name', 'last_name', 'phone', 'whatsapp_consent', 'created_at',
      [sequelize.literal('("Tenant"."user_id" IS NOT NULL)'), 'has_account'],
      [sequelize.literal(`(SELECT count(*)::int FROM leases l WHERE l.tenant_id = "Tenant"."id" AND l.status = 'actif')`), 'active_leases'],
    ],
    include: [{ model: Owner, as: 'owner', attributes: ['id', 'display_name', 'status'] }],
    order: ordre(filtres.tri, '-created_at'),
    limit,
    offset,
  });
}

// ── Immeubles ──────────────────────────────────────────────────────────────

async function listerImmeubles(filtres, { limit, offset }) {
  const where = {};
  if (filtres.owner_id) where.owner_id = filtres.owner_id;
  if (filtres.city) where.city = filtres.city;
  const texte = rechercheTexte(filtres.q, ['name', 'address', 'district', 'city']);
  if (texte) Object.assign(where, texte);
  return Building.findAndCountAll({
    where,
    attributes: {
      exclude: ['description'],
      include: [
        [sequelize.literal('(SELECT count(*)::int FROM apartments a WHERE a.building_id = "Building"."id" AND a.deleted_at IS NULL)'), 'apartments_count'],
        [sequelize.literal('(SELECT count(*)::int FROM apartments a WHERE a.building_id = "Building"."id" AND a.deleted_at IS NULL AND a.status = \'occupe\')'), 'occupied_count'],
        [sequelize.literal('(SELECT count(*)::int FROM apartments a WHERE a.building_id = "Building"."id" AND a.deleted_at IS NULL AND a.status = \'disponible\')'), 'available_count'],
      ],
    },
    include: [{ model: Owner, as: 'owner', attributes: ['id', 'display_name', 'status'] }],
    order: ordre(filtres.tri, 'name'),
    limit,
    offset,
  });
}

// ── Signalements ───────────────────────────────────────────────────────────

function filtresIncidents(filtres) {
  const where = {};
  if (filtres.status) where.status = filtres.status;
  if (filtres.category) where.category = filtres.category;
  if (filtres.owner_id) where.owner_id = filtres.owner_id;
  if (filtres.du || filtres.au) {
    where.created_at = periode(
      filtres.du ? new Date(`${filtres.du}T00:00:00Z`) : null,
      filtres.au ? new Date(`${filtres.au}T23:59:59.999Z`) : null
    );
  }
  return where;
}

async function listerSignalements(filtres, { limit, offset }) {
  return Incident.findAndCountAll({
    where: filtresIncidents(filtres),
    // Aucune donnée du locataire (ni nom, ni contact) : l'administrateur suit
    // la qualité de service de la plateforme, pas les personnes.
    attributes: [
      'id', 'owner_id', 'building_id', 'apartment_id', 'reference', 'category', 'title', 'status',
      'analysed_at', 'resolved_at', 'rejected_at', 'created_at',
      [sequelize.literal('(SELECT o.display_name FROM owners o WHERE o.id = "Incident"."owner_id")'), 'owner_name'],
    ],
    include: [
      { model: Building, as: 'building', attributes: ['id', 'name', 'city'], paranoid: false },
      { model: Apartment, as: 'apartment', attributes: ['id', 'number'], paranoid: false },
    ],
    order: ordre(filtres.tri, '-created_at'),
    limit,
    offset,
  });
}

/** Répartition des signalements par statut et par catégorie (une requête). */
async function statistiquesSignalements(filtres) {
  const where = filtresIncidents(filtres);
  const lignes = await Incident.findAll({
    where,
    attributes: ['status', 'category', [sequelize.fn('count', sequelize.col('id')), 'nombre']],
    group: ['status', 'category'],
    raw: true,
  });
  const parStatut = {};
  const parCategorie = {};
  let total = 0;
  for (const l of lignes) {
    const n = Number(l.nombre);
    parStatut[l.status] = (parStatut[l.status] || 0) + n;
    parCategorie[l.category] = (parCategorie[l.category] || 0) + n;
    total += n;
  }
  return { total, by_status: parStatut, by_category: parCategorie };
}

module.exports = {
  listerProprietaires, detailProprietaire, suspendre, reactiver,
  listerLocataires, listerImmeubles, listerSignalements, statistiquesSignalements,
};
