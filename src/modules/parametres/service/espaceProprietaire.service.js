'use strict';

const sequelize = require('../../../config/db.js');
const { Owner } = require('../../../models/index.js');
const { parametresProprietaire } = require('../../../config/parametres.js');
const { journaliser, difference } = require('../../audit/service/audit.service.js');

/**
 * Paramètres de l'espace propriétaire : délais de relance (§ 14), politique
 * d'état des lieux (§ 52.4), délais de réponse et de restitution (§ 52, § 55),
 * canaux de notification (§ 54.3) — et identité du bailleur, reprise dans les
 * contrats (§ 53) et les quittances (§ 13).
 */

const CHAMPS_PROFIL = ['display_name', 'company_name', 'phone', 'email', 'address', 'city'];

async function lire(ownerId) {
  const owner = await Owner.findByPk(ownerId);
  return { owner, settings: parametresProprietaire(owner) };
}

async function modifierReglages(ownerId, reglages) {
  return sequelize.transaction(async (t) => {
    const owner = await Owner.findByPk(ownerId, { transaction: t, lock: t.LOCK.UPDATE });
    const avant = parametresProprietaire(owner);
    await owner.update({ settings: { ...(owner.settings || {}), ...reglages } }, { transaction: t });
    await journaliser({ action: 'parametres.modification', entityType: 'owner', entityId: ownerId, ownerId, details: difference(avant, reglages, Object.keys(reglages)) }, t);
    return parametresProprietaire(owner);
  });
}

async function modifierProfil(ownerId, donnees) {
  return sequelize.transaction(async (t) => {
    const owner = await Owner.findByPk(ownerId, { transaction: t, lock: t.LOCK.UPDATE });
    const avant = owner.toJSON();
    await owner.update(donnees, { transaction: t, fields: CHAMPS_PROFIL });
    await journaliser({ action: 'parametres.modification_profil', entityType: 'owner', entityId: ownerId, ownerId, details: difference(avant, donnees, CHAMPS_PROFIL) }, t);
    return owner;
  });
}

module.exports = { lire, modifierReglages, modifierProfil };
