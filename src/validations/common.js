'use strict';

const Joi = require('joi');
const { normaliserTelephone } = require('../utils/telephone.js');

/**
 * Briques de validation partagées (reprises de Widjila et adaptées).
 * Toute entrée est bornée (longueur, plage) : aucune chaîne illimitée
 * n'atteint un service, une regex ou la base (ReDoS, déni de service).
 */

const uuid = Joi.string().guid({ version: ['uuidv4', 'uuidv5', 'uuidv7'] });

/** Téléphone normalisé en E.164 (+221…) dès la validation. */
const telephone = Joi.string().trim().max(25).custom((valeur, aide) => {
  const normalise = normaliserTelephone(valeur);
  if (!normalise) return aide.message('{{#label}} doit être un numéro de téléphone valide');
  return normalise;
});

const email = Joi.string().trim().lowercase().max(254).email({ tlds: { allow: false } });

const motDePasse = Joi.string().min(8).max(128)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
  .message('{{#label}} doit contenir au moins 8 caractères, une majuscule, une minuscule et un chiffre');

const nom = Joi.string().trim().min(1).max(80);

/** Montant en FCFA entiers. */
const montant = Joi.number().integer().min(0).max(1_000_000_000_000);
const montantPositif = Joi.number().integer().min(1).max(1_000_000_000_000);

/**
 * Date calendaire AAAA-MM-JJ (renvoyée en chaîne, sans décalage de fuseau),
 * qui EXISTE au calendrier : le motif seul accepte « 2026-02-30 », que
 * PostgreSQL refuse ensuite (22007 → 500) sur toute route filtrée par date.
 */
const dateExiste = (v) => {
  const [a, m, j] = v.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
};
const dateIso = Joi.string().trim().pattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  .message('{{#label}} doit être une date au format AAAA-MM-JJ')
  .custom((v, aide) => (dateExiste(v) ? v : aide.message('{{#label}} n’est pas une date du calendrier')));

const texteCourt = Joi.string().trim().max(255);
const texteLong = Joi.string().trim().max(5000);

const paramId = Joi.object({ id: uuid.required() });

/**
 * Paramètre de tri `?tri=-created_at` restreint à une liste blanche : le nom
 * de colonne ne vient JAMAIS directement du client (injection SQL par ORDER BY).
 * @param {string[]} champs
 */
const tri = (champs) => Joi.string().trim().valid(...champs.flatMap((c) => [c, `-${c}`]));

/** Recherche textuelle bornée. */
const recherche = Joi.string().trim().max(100).allow('');

/** Pagination (bornes réelles appliquées par pagination.middleware). */
const pagination = {
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1),
};

module.exports = {
  Joi, uuid, telephone, email, motDePasse, nom, montant, montantPositif, dateIso,
  texteCourt, texteLong, paramId, tri, recherche, pagination,
};
