'use strict';

const { ValidationError } = require('../errors/AppError.js');
const logger = require('../utils/logger.js');
const masquerUrl = require('../utils/masquerUrl.js');

/**
 * Valide `req[source]` (body, query, params) contre un schéma Joi.
 *
 * - `stripUnknown` : un client ne peut jamais injecter une colonne non prévue
 *   (ex. `owner_id`, `status`, `amount_paid`) — protection contre l'affectation
 *   de masse. Les champs retirés sont journalisés (reprise de Widjila) : une
 *   faute de frappe côté client ne disparaît plus en silence.
 * - `convert` : types normalisés (nombres, dates, booléens).
 *
 * Sous Express 5, `req.query` est un GETTER non mémoïsé : muter son résultat
 * ne sert à rien (défaut relevé dans Widjila). On pose donc une propriété
 * PROPRE sur `req`, qui masque le getter pour le reste de la requête.
 *
 * Usage : router.post('/', validate(schema), controller)
 *         router.get('/', validate(filtres, 'query'), controller)
 */
const validate = (schema, source = 'body') => (req, res, next) => {
  const brut = req[source] ?? {};
  const { error, value } = schema.validate(brut, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });

  if (error) {
    return next(new ValidationError('Données invalides', error.details.map((d) => d.message)));
  }

  if (brut && typeof brut === 'object' && !Array.isArray(brut)) {
    const retirees = Object.keys(brut).filter((cle) => !(cle in (value || {})));
    if (retirees.length) {
      logger.warn(`[validate] ${req.method} ${masquerUrl(req.originalUrl)} — champ(s) ${source} ignoré(s) : ${retirees.join(', ')}`);
    }
  }

  if (source === 'query') {
    Object.defineProperty(req, 'query', { value, writable: true, enumerable: true, configurable: true });
  } else {
    req[source] = value;
  }
  next();
};

module.exports = validate;
