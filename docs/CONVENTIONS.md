# Conventions de développement

Architecture reprise de **Widjila** (modules `route → controller → service → model`)
et de **Sign** (même socle Express 5 / Sequelize / Joi / winston / JWT / R2 /
Resend / FCM / PM2 / Docker). Lire aussi `docs/ANALYSE_CAHIER_DES_CHARGES.md`.

## 1. Arborescence d'un module

```
src/modules/<module>/
  route/<module>.route.js            routes de l'espace propriétaire (ou admin)
  route/<module>Locataire.route.js   routes de l'espace locataire, si besoin
  controller/<module>.controller.js  mince : lit req, appelle le service, répond
  service/<module>.service.js        TOUTE la logique métier et l'accès aux données
  validation/<module>.validation.js  schémas Joi
```

Les routeurs sont montés dans `src/routes.js`, qui applique la garde de
l'espace (auth, propriétaire, abonnement, limite de débit). Un routeur de
module n'applique donc QUE `requirePermission(P.X)` + `validate(...)` +
`paginate()` / `idempotence()` / `recevoirFichier()`.

## 2. Contrôle d'accès (§ 32, § 43) — non négociable

- Tout identifiant venant du client (param, body) passe par
  `utils/acces.js` : `chargerPourProprietaire(Modele, id, req.ownerId, options, 'Libellé')`
  (404 si absent, **403 si autre propriétaire**) ou `verifierReference(...)` pour un
  id référencé dans le corps (422 si absent, 403 si autre propriétaire).
- Toute requête de liste filtre `owner_id: ownerId` (ou `tenant_id` ∈ `req.tenantIds`
  côté locataire). Jamais de requête sur un id seul.
- Côté locataire : `chargerPourLocataire(Modele, id, req.tenantIds, options, 'Libellé')`.
- Jamais de `owner_id`, `status`, `amount_paid`… accepté du client : Joi
  (`stripUnknown`) les retire.

## 3. Services

- Signature : `(ownerId, ...)` ou `(id, ownerId, donnees)` ; l'utilisateur
  (`req.user`) est passé quand il faut l'enregistrer (`created_by`).
- Écritures dans `sequelize.transaction(async (t) => …)` ;
  `transactionAvecFichiers` (src/database/transaction.js) dès qu'un fichier est stocké.
- Verrou de ligne (`lock: t.LOCK.UPDATE`) avant toute transition de statut.
- Journal d'audit dans la MÊME transaction :
  `journaliser({ action: '<ressource>.<action>', entityType, entityId, ownerId, details }, t)`
  avec `action` ∈ creation, modification, suppression, paiement, remboursement,
  changement_statut, ajout_document, modification_loyer (§ 40).
- Notifications : `notifier(t, { destinataires, ownerId, type, titre, corps, donnees, whatsapp? })`
  (module notification) — écrite dans la transaction, diffusée après COMMIT.
- Suppression : logique (`paranoid`) ou statut `annule(e)` ; jamais de DELETE
  physique d'une donnée financière (§ 42).
- Transitions : tables de `config/transitions.js` + `verifierTransition`.
- Numérotation lisible : `prochainNumero(\`owner:${ownerId}:<portée>\`, t)` + `pad()`.
- Erreurs : `throw new ConflictError(message, 'CODE_STABLE')` etc. (`errors/AppError.js`).
  Le code est en MAJUSCULES, stable, documenté.

## 4. Requêtes et performance

- Listes : `findAndCountAll` + `include` (jointures en une requête) +
  `distinct: true` si un `include` est `hasMany` + `order: ordre(req.query.tri, défaut)`.
- Agrégats : une requête SQL (`sequelize.query` + `replacements` nommés, jamais
  de concaténation de valeurs client) ; `QueryTypes.SELECT`.
- Jamais de requête dans une boucle sur des lignes (N+1).
- Montants : FCFA entiers (`BIGINT`), `utils/montants.js` pour répartir.
- Dates métier : chaînes `AAAA-MM-JJ`, `utils/dates.js` (`aujourdhui()` dans le fuseau).

## 5. Contrôleurs et réponses

```js
exports.lister = asyncHandler(async (req, res) =>
  paginated(res, await S.lister(req.ownerId, req.query, req.pagination), req.pagination));
exports.detail = asyncHandler(async (req, res) => ok(res, { work_order: await S.detail(req.params.id, req.ownerId) }));
exports.creer  = asyncHandler(async (req, res) => created(res, { work_order: await S.creer(req.ownerId, req.user, req.body) }, 'Travaux créés'));
```

JSON en `snake_case`. Enveloppe : `{ success, message, data }` ; listes :
`data: { items, pagination }`. Les erreurs ne sont JAMAIS formatées à la main.

## 6. Validation

`validations/common.js` : `uuid`, `telephone` (normalisé E.164), `email`,
`montant`, `montantPositif`, `dateIso`, `tri([...])`, `recherche`, `pagination`,
`paramId`. Toute chaîne est bornée (`max`). Les énumérations viennent de
`config/enums.js` (`codes(ENUM)`).

## 7. Fichiers

Route : `recevoirFichier('image' | 'justificatif' | 'media' | 'document')` (pose
`req.fichier`) ; service : `documents.creerDocument({...}, t)` dans
`transactionAvecFichiers`. Le document porte `owner_id`, `tenant_id` (si le
locataire est concerné) et `visible_to_tenant`.

## 8. Tests

Jest + supertest sur une vraie base PostgreSQL (`src/__tests__/integration`),
aides dans `src/__tests__/setup/helpers.js`. Chaque module teste au minimum :
parcours nominal, validation (422), accès d'un AUTRE propriétaire (403),
ressource absente (404), règles métier et transitions interdites (409).

## 9. Style

Commentaires en français, expliquant le POURQUOI (règle du cahier des charges
citée par son §). Pas de TODO, pas de code mort, pas de donnée fictive.
