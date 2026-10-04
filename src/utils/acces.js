'use strict';

const { NotFoundError, ForbiddenError, ValidationError } = require('../errors/AppError.js');

/**
 * Contrôle d'accès HORIZONTAL (§ 32, § 43) — point de passage unique.
 *
 * Toute ressource désignée par un identifiant venant du client (paramètre de
 * route, champ du corps) est chargée PAR SON ID, puis son `owner_id` est
 * comparé à l'espace de l'appelant :
 *   - absente (ou supprimée logiquement) → 404 ;
 *   - présente mais d'un autre propriétaire → 403 Forbidden.
 *
 * Le 403 est exigé tel quel par le test critique du cahier des charges
 * (« le propriétaire A tente d'accéder à l'appartement du propriétaire B →
 * 403 »). Les identifiants sont des UUID v4 aléatoires : distinguer 403 de 404
 * ne permet pas d'énumérer les ressources d'autrui.
 *
 * Un changement d'ID dans une requête ne peut donc JAMAIS atteindre les données
 * d'un autre propriétaire : aucune requête métier ne filtre sur un id sans être
 * passée par ici ou sans porter `owner_id` dans sa clause WHERE.
 */

/**
 * @template T
 * @param {import('sequelize').ModelStatic<T>} Modele
 * @param {string} id
 * @param {string} ownerId          espace de l'appelant (req.ownerId)
 * @param {object} [options]        options Sequelize (include, attributes, transaction, lock)
 * @param {string} [libelle]        nom lisible de la ressource pour le message
 * @returns {Promise<T>}
 */
async function chargerPourProprietaire(Modele, id, ownerId, options = {}, libelle = 'Ressource') {
  const ressource = await Modele.findByPk(id, options);
  if (!ressource) throw new NotFoundError(`${libelle} introuvable`);
  if (ressource.owner_id !== ownerId) {
    throw new ForbiddenError("Vous n'avez pas accès à cette ressource.", 'ACCES_AUTRE_PROPRIETAIRE');
  }
  return ressource;
}

/**
 * Variante pour le locataire : la ressource doit appartenir à l'une de SES
 * fiches locataire (`req.tenantIds`). Un locataire ne voit jamais les données
 * d'un autre locataire (§ 28).
 *
 * @param {string[]} tenantIds
 * @param {string} [champ='tenant_id']
 */
async function chargerPourLocataire(Modele, id, tenantIds, options = {}, libelle = 'Ressource', champ = 'tenant_id') {
  const ressource = await Modele.findByPk(id, options);
  if (!ressource) throw new NotFoundError(`${libelle} introuvable`);
  if (!tenantIds.includes(ressource[champ])) {
    throw new ForbiddenError("Vous n'avez pas accès à cette ressource.", 'ACCES_AUTRE_LOCATAIRE');
  }
  return ressource;
}

/**
 * Vérifie qu'une ressource RÉFÉRENCÉE dans un corps de requête (ex. `building_id`
 * d'une dépense) appartient bien au même propriétaire. Identique à
 * `chargerPourProprietaire`, mais une référence inexistante est une donnée
 * invalide (422) plutôt qu'une URL fausse (404).
 */
async function verifierReference(Modele, id, ownerId, libelle, options = {}) {
  if (id === null || id === undefined) return null;
  const ressource = await Modele.findByPk(id, options);
  if (!ressource) throw new ValidationError('Données invalides', [`${libelle} introuvable`]);
  if (ressource.owner_id !== ownerId) {
    throw new ForbiddenError("Vous n'avez pas accès à cette ressource.", 'ACCES_AUTRE_PROPRIETAIRE');
  }
  return ressource;
}

module.exports = { chargerPourProprietaire, chargerPourLocataire, verifierReference };
