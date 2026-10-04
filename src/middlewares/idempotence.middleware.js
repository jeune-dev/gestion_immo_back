'use strict';

const crypto = require('node:crypto');
const { UniqueConstraintError } = require('sequelize');
const { IdempotencyKey } = require('../models/index.js');
const { ConflictError, ValidationError } = require('../errors/AppError.js');
const logger = require('../utils/logger.js');

/**
 * Idempotence des requêtes mutantes — en-tête `Idempotency-Key`.
 *
 * Répond à trois cas du cahier des charges :
 *   - § 44 « double clic » : deux envois identiques ne créent qu'une ressource ;
 *   - § 44 « réseau coupé / retour dans l'application » : le mobile renvoie la
 *     requête avec la MÊME clé et reçoit la réponse d'origine ;
 *   - § 34 « synchronisation différée » : une opération faite hors ligne est
 *     rejouée sans risque de doublon.
 *
 * Fonctionnement :
 *   1. insertion de (utilisateur, clé) — l'index UNIQUE arbitre la concurrence ;
 *   2. clé déjà connue :
 *        - même requête, terminée  → la réponse enregistrée est rejouée ;
 *        - même requête, en cours  → 409 REQUETE_EN_COURS ;
 *        - requête DIFFÉRENTE      → 422 (réutilisation d'une clé : bug client) ;
 *   3. à la fin, seule une réponse DÉFINITIVE est enregistrée (voir
 *      `aConserver`) : 2xx, et les refus qui ne changeront pas si l'on renvoie
 *      la même requête (400, 404, 422). Une réponse liée à un état passager —
 *      401 session expirée, 402 abonnement échu, 403 droit retiré, 409 conflit
 *      d'état, 429 limite de débit — ou une erreur serveur (5xx) LIBÈRE la clé :
 *      une fois l'obstacle levé, la même requête avec la même clé est traitée
 *      (§ 44 « session expirée », « réseau coupé » puis nouvelle tentative).
 *
 * `obligatoire: true` rend l'en-tête exigé (initiation de paiement).
 */

const FORMAT_CLE = /^[A-Za-z0-9_.:-]{8,128}$/;
const DUREE_HEURES = parseInt(process.env.IDEMPOTENCE_DUREE_HEURES || '24', 10);

/** Refus définitifs : la même requête recevra toujours la même réponse. */
const REFUS_DEFINITIFS = new Set([400, 404, 422]);

/**
 * Décision pure : faut-il conserver (et rejouer) cette réponse ?
 * @param {number} statut        code HTTP envoyé
 * @param {boolean} terminee     réponse entièrement écrite (pas de coupure)
 * @param {boolean} corpsCapture corps JSON disponible pour être rejoué
 */
function aConserver(statut, terminee, corpsCapture) {
  if (!terminee || !corpsCapture) return false;
  return (statut >= 200 && statut < 300) || REFUS_DEFINITIFS.has(statut);
}

/**
 * Empreinte de la requête : route, corps ET fichier téléversé. Sur une route
 * multipart, le middleware doit donc être placé APRÈS `recevoirFichier` —
 * avant, le corps n'est pas encore lu et deux envois différents (autre
 * fichier, autre preuve de paiement) auraient la même empreinte.
 */
function empreinte(req) {
  const hash = crypto.createHash('sha256')
    .update(`${req.method} ${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? null)}`);
  if (req.file?.buffer) hash.update('\n').update(req.file.buffer);
  return hash.digest('hex');
}

const idempotence = ({ obligatoire = false } = {}) => async (req, res, next) => {
  const cle = req.headers['idempotency-key'];
  if (!cle) {
    if (obligatoire) return next(new ValidationError('En-tête Idempotency-Key requis pour cette opération', [], 'IDEMPOTENCE_REQUISE'));
    return next();
  }
  if (typeof cle !== 'string' || !FORMAT_CLE.test(cle)) {
    return next(new ValidationError('En-tête Idempotency-Key invalide (8 à 128 caractères alphanumériques)', [], 'IDEMPOTENCE_INVALIDE'));
  }
  if (!req.user) return next();

  const hash = empreinte(req);
  let entree;
  try {
    entree = await IdempotencyKey.create({
      user_id: req.user.id,
      key: cle,
      method: req.method,
      path: `${req.baseUrl}${req.path}`.slice(0, 300),
      request_hash: hash,
      status: 'en_cours',
      expires_at: new Date(Date.now() + DUREE_HEURES * 3600 * 1000),
    });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) return next(err);
    try {
      const existante = await IdempotencyKey.findOne({ where: { user_id: req.user.id, key: cle } });
      if (!existante) return next(new ConflictError('Requête en cours de traitement, réessayez', 'REQUETE_EN_COURS'));
      if (existante.request_hash !== hash) {
        return next(new ValidationError('Cette clé d’idempotence a déjà servi pour une autre requête', [], 'IDEMPOTENCE_REUTILISEE'));
      }
      if (existante.status === 'en_cours') {
        return next(new ConflictError('Requête identique déjà en cours de traitement', 'REQUETE_EN_COURS'));
      }
      res.setHeader('Idempotent-Replayed', 'true');
      return res.status(existante.response_status).json(existante.response_body);
    } catch (e) {
      return next(e);
    }
  }

  // Capture du corps de la réponse pour pouvoir la rejouer.
  const jsonOriginal = res.json.bind(res);
  let corps;
  let liberee = false;
  res.json = (valeur) => {
    corps = valeur;
    // Réponse passagère (401/402/403/409/429/5xx) : la clé est LIBÉRÉE AVANT
    // l'envoi. Libérée seulement à la fermeture, un client qui réessayait
    // aussitôt (le cas même de ces refus) pouvait encore tomber sur
    // « requête en cours » — course observée sous charge.
    if (!aConserver(res.statusCode, true, true)) {
      liberee = true;
      entree.destroy()
        .catch((err) => logger.warn('[idempotence] Libération de la clé impossible', { error: err.message }))
        .finally(() => jsonOriginal(valeur));
      return res;
    }
    return jsonOriginal(valeur);
  };

  // `close` (et non `finish`) : une connexion coupée avant la fin de la réponse
  // doit LIBÉRER la clé, sinon chaque nouvelle tentative recevrait
  // « requête en cours » pendant toute la durée de rétention.
  res.on('close', () => {
    if (liberee) return;
    const aRejouer = aConserver(res.statusCode, res.writableFinished, corps !== undefined);
    const operation = !aRejouer
      ? entree.destroy()
      : entree.update({ status: 'termine', response_status: res.statusCode, response_body: corps ?? null });
    operation.catch((err) => logger.warn('[idempotence] Enregistrement de la réponse impossible', { error: err.message }));
  });

  return next();
};

module.exports = idempotence;
module.exports.aConserver = aConserver;
