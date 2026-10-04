'use strict';

const { Op } = require('sequelize');
const { Notification } = require('../../../models/index.js');
const { NotFoundError } = require('../../../errors/AppError.js');

/**
 * Consultation des notifications internes (§ 27, § 28 menu « Notifications »).
 *
 * Séparé de notification.service.js (émission et diffusion multicanale) : la
 * lecture ne touche ni au push ni à WhatsApp, et une évolution de l'une ne
 * peut pas casser l'autre.
 *
 * Portée : une notification appartient à UN compte (`user_id`). Toute requête
 * filtre sur `user_id = req.user.id` — propriétaire, locataire ou super admin,
 * chacun ne voit que les siennes. Une notification d'un autre compte répond
 * 404 (et non 403) : il n'y a pas d'« espace » à révéler, seulement une ligne
 * qui, pour l'appelant, n'existe pas.
 */

const ATTRIBUTS = ['id', 'type', 'title', 'body', 'data', 'read_at', 'created_at'];

/**
 * Mes notifications, les plus récentes d'abord (index notifications_user_idx).
 * @param {string} userId
 * @param {{ non_lues?: boolean }} filtres
 * @param {{ limit: number, offset: number }} pagination
 */
async function lister(userId, { non_lues: nonLues } = {}, { limit, offset }) {
  const where = { user_id: userId };
  if (nonLues) where.read_at = null;
  return Notification.findAndCountAll({
    where,
    attributes: ATTRIBUTS,
    order: [['created_at', 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
}

/**
 * Nombre de notifications non lues (pastille du mobile, appelée souvent) :
 * `user_id = … AND read_at IS NULL` correspond exactement à l'index partiel
 * notifications_non_lues_idx — le décompte ne lit que les lignes non lues.
 */
async function compterNonLues(userId) {
  return Notification.count({ where: { user_id: userId, read_at: null } });
}

/** Marque UNE de mes notifications comme lue (idempotent). */
async function marquerLue(id, userId) {
  const notification = await Notification.findOne({ where: { id, user_id: userId }, attributes: ATTRIBUTS });
  if (!notification) throw new NotFoundError('Notification introuvable');
  if (!notification.read_at) await notification.update({ read_at: new Date() });
  return notification;
}

/** Marque toutes mes notifications non lues comme lues ; renvoie leur nombre. */
async function toutLire(userId) {
  const [nombre] = await Notification.update(
    { read_at: new Date() },
    { where: { user_id: userId, read_at: { [Op.is]: null } } }
  );
  return nombre;
}

module.exports = { lister, compterNonLues, marquerLue, toutLire };
