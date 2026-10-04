'use strict';

const crypto = require('node:crypto');
const { executerDansContexte } = require('../utils/requestContext.js');

/**
 * Identifiant de corrélation de la requête — `X-Request-Id`.
 *
 * Aucune requête n'en portait : une erreur signalée par un utilisateur (« ça a
 * planté vers 10h ») ne pouvait être retrouvée dans les journaux qu'en croisant
 * l'heure, la route et l'IP, sans certitude. L'identifiant est désormais :
 *   - REPRIS du client quand il en fournit un valide — le mobile envoie le
 *     sien, et celui d'une action de synchronisation hors ligne est l'id de
 *     l'action en file : la même valeur se lit dans le journal du téléphone,
 *     dans l'en-tête et dans le journal serveur ;
 *   - sinon GÉNÉRÉ ici ;
 *   - renvoyé dans l'en-tête de réponse et dans le corps de toute erreur ;
 *   - posé dans le contexte asynchrone, que le logger lit pour l'ajouter à
 *     chaque ligne écrite pendant la requête.
 *
 * Le format entrant est borné : cette valeur finit dans les journaux, un
 * client ne doit pas pouvoir y injecter de saut de ligne ni un texte géant.
 *
 * Synchrone, sans aucun `await` : il est traversé par chaque requête.
 */
const FORMAT_VALIDE = /^[A-Za-z0-9_.:-]{8,128}$/;

function identifiantEntrant(valeur) {
  const brut = Array.isArray(valeur) ? valeur[0] : valeur;
  return typeof brut === 'string' && FORMAT_VALIDE.test(brut) ? brut : null;
}

function requestId(req, res, next) {
  const id = identifiantEntrant(req.headers['x-request-id']) || crypto.randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);

  // Accesseurs et non valeurs : l'utilisateur n'est connu qu'après `auth`,
  // qui passe bien après ce middleware.
  const contexte = {
    requestId: id,
    get utilisateurId() { return req.user?.id ?? null; },
    get utilisateurRole() { return req.user?.role_code ?? null; },
    get ownerId() { return req.ownerId ?? null; },
    // Lus par le journal d'audit (§ 40) sans faire descendre `req` dans les services.
    get ip() { return req.ip ?? null; },
    get userAgent() { return req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 300) : null; },
  };
  executerDansContexte(contexte, next);
}

module.exports = requestId;
module.exports.identifiantEntrant = identifiantEntrant;
