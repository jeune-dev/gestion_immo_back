'use strict';

const sequelize = require('../../../config/db.js');
const { Building, Apartment } = require('../../../models/index.js');
const { chargerPourProprietaire } = require('../../../utils/acces.js');
const { ordre, rechercheTexte } = require('../../../utils/liste.js');
const { ConflictError } = require('../../../errors/AppError.js');
const droits = require('../../abonnement/service/droits.service.js');
const documents = require('../../document/service/document.service.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Immeubles (§ 7) : adresse, étages, nombre d'appartements, description,
 * photos et documents (via le module document).
 */

const CHAMPS = ['name', 'address', 'district', 'city', 'floors_count', 'declared_apartments_count', 'description'];

/**
 * Statistiques d'occupation calculées DANS la requête de liste (sous-requêtes
 * corrélées indexées sur apartments.building_id) : une seule requête pour la
 * page entière, jamais une requête par immeuble (pas de N+1).
 */
const ATTRIBUTS_STATS = [
  [sequelize.literal('(SELECT count(*) FROM apartments a WHERE a.building_id = "Building"."id" AND a.deleted_at IS NULL)'), 'apartments_count'],
  [sequelize.literal('(SELECT count(*) FROM apartments a WHERE a.building_id = "Building"."id" AND a.deleted_at IS NULL AND a.status = \'occupe\')'), 'occupied_count'],
  [sequelize.literal('(SELECT count(*) FROM apartments a WHERE a.building_id = "Building"."id" AND a.deleted_at IS NULL AND a.status = \'disponible\')'), 'available_count'],
];

async function lister(ownerId, filtres, { limit, offset }) {
  const where = { owner_id: ownerId };
  if (filtres.city) where.city = filtres.city;
  const texte = rechercheTexte(filtres.q, ['name', 'address', 'district', 'city']);
  if (texte) Object.assign(where, texte);

  return Building.findAndCountAll({
    where,
    attributes: { include: ATTRIBUTS_STATS },
    order: ordre(filtres.tri, 'name'),
    limit,
    offset,
  });
}

async function detail(id, ownerId) {
  const building = await chargerPourProprietaire(Building, id, ownerId, { attributes: { include: ATTRIBUTS_STATS } }, 'Immeuble');
  const pieces = await documents.listerPourEntite('building', building.id);
  return { ...building.toJSON(), documents: pieces.map(documents.versApi) };
}

async function creer(ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    await droits.verifierLimite(ownerId, 'buildings', t);
    const building = await Building.create({ ...donnees, owner_id: ownerId }, { transaction: t });
    await journaliser({ action: 'immeuble.creation', entityType: 'building', entityId: building.id, ownerId, details: { name: building.name } }, t);
    return building;
  });
}

async function modifier(id, ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const building = await chargerPourProprietaire(Building, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Immeuble');
    const avant = building.toJSON();
    await building.update(donnees, { transaction: t, fields: CHAMPS });
    await journaliser({
      action: 'immeuble.modification', entityType: 'building', entityId: id, ownerId,
      details: difference(avant, donnees, CHAMPS),
    }, t);
    return building;
  });
}

/**
 * Suppression LOGIQUE (§ 42). Refusée tant que l'immeuble contient des
 * appartements : leurs baux, loyers et dépenses en dépendent.
 */
async function supprimer(id, ownerId) {
  return sequelize.transaction(async (t) => {
    const building = await chargerPourProprietaire(Building, id, ownerId, { transaction: t, lock: t.LOCK.UPDATE }, 'Immeuble');
    const nb = await Apartment.count({ where: { building_id: id }, transaction: t });
    if (nb > 0) {
      throw new ConflictError(`Impossible de supprimer un immeuble qui contient ${nb} appartement(s).`, 'IMMEUBLE_NON_VIDE');
    }
    await building.destroy({ transaction: t });
    await journaliser({ action: 'immeuble.suppression', entityType: 'building', entityId: id, ownerId, details: { name: building.name } }, t);
  });
}

module.exports = { lister, detail, creer, modifier, supprimer };
