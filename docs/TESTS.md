# Stratégie de tests

Objectif : prouver que le backend est **fiable, sécurisé et conforme au cahier
des charges** — pas seulement qu'il répond 200. Chaque test vérifie le statut
HTTP, **le contenu de la réponse, l'état de la base et les effets de bord**
(montants, statuts, caisse, quittances, journal d'audit, notifications,
fichiers).

## 1. Organisation

```
src/__tests__/
  setup/              env.js (base par worker), globalSetup.js (migrations + seeders,
                      clonage), helpers.js (création par l'API), jeuComplet.js
                      (une ressource de chaque type), routeHits.js (couverture des routes)
  unit/               sans base de données
    services/         règles métier pures (échéances, caution, répartition, états des lieux…)
    utils/ middlewares/ infrastructure/ config/ validations/ models/
  integration/        API HTTP réelle (supertest) + vraie base PostgreSQL
    api/<module>/     un dossier par module réellement présent (29 modules)
    securite/         matrices sur TOUTES les routes (authentification, rôles, IDOR,
                      identifiants malformés, pagination, recherche, tri, injection)
    postgres/         contraintes SQL, cohérence énumérations ↔ CHECK, transactions
    concurrence/      courses critiques (doubles créations, paiements, activations)
  e2e/                parcours utilisateurs complets, succès ET échecs
    immobilier/ finances/ location/ auth/ administration/
```

## 2. Commandes

| Commande | Rôle |
|---|---|
| `npm test` | Toute la suite (unit + integration + e2e), en parallèle |
| `npm run test:unit` | Tests unitaires seuls (aucune base) |
| `npm run test:integration` | API, sécurité, PostgreSQL, concurrence |
| `npm run test:e2e` | Parcours de bout en bout |
| `npm run test:coverage` | Toute la suite avec couverture (`coverage/`) |
| `npm run test:routes` | Après une exécution : routes testées / non testées (`coverage/routes.md`) |
| `npm run test:serie` | Exécution séquentielle (diagnostic) |
| `npm run test:ordre-aleatoire` | Ordre des tests aléatoire (preuve d'indépendance) |
| `npm run test:watch` | Mode surveillance |
| `npx jest --runTestsByPath <fichiers>` | Fichiers précis (les chemins APRÈS `--selectProjects` seraient lus comme des noms de projet) |

`JEST_WORKERS=<n>` règle le parallélisme (2 par défaut : postes à mémoire limitée).

## 3. Base de données de test

- `.env.test` (jamais `.env`) ; `DB_NAME` **doit contenir « test »**, sinon la
  suite refuse de démarrer — la base de production ne peut pas être touchée.
- `globalSetup` reconstruit la base **modèle** exactement comme un déploiement
  (migrations, seeders, rôles), puis en **clone une par worker**
  (`CREATE DATABASE … TEMPLATE`) : l'exécution parallèle est isolée.
- Aucun test ne dépend d'un autre : chacun crée son propre propriétaire,
  patrimoine et locataire via l'API (téléphones et e-mails uniques). Les
  seules données partagées sont les données de référence (plans, catégories,
  modèles), jamais modifiées sans être rétablies.
- Seuls les appels SORTANTS vers des tiers sont simulés (PayDunya, Wave, Meta,
  FCM, Resend). Base, transactions, fichiers, PDF, signatures : réels.

## 4. Ce que couvre chaque niveau

| Niveau | Garanties |
|---|---|
| Unitaire | calculs (répartition au franc près, prorata, statuts), dates, validations Joi, normalisation d'erreurs, signatures, chiffrement, stockage, images (EXIF retiré), PDF, garde-fous de démarrage en production |
| API | pour chaque route : nominal, 401/403/404/409/422, validation de chaque champ, pagination, filtres, tri, règles métier en succès et en échec, effets en base |
| Sécurité | les 262 routes sont LUES sur le routeur : sans jeton → 401 ; jeton falsifié / expiré / refresh / autre secret → 401 ; profil d'un autre espace → 403 ; identifiants d'un autre propriétaire ou locataire → jamais de 2xx ET empreinte SQL de ses données inchangée ; identifiant malformé → jamais de 500 ; erreurs sans pile ni SQL |
| PostgreSQL | chaque CHECK / UNIQUE / FK violé volontairement (code d'erreur exact) ; 51 énumérations comparées aux CHECK ; suppression logique |
| Transactions | succès = tout est écrit ; échec = aucune ligne partielle, aucun journal d'audit, aucun fichier orphelin, aucun numéro consommé |
| Concurrence | activations simultanées sur un appartement, inscriptions et invitations en double, paiements et remboursements simultanés, tâches planifiées en double, limite de formule |
| E2E | mise en location complète, encaissement par tous les canaux, charges communes, incident → travaux → dépense, fin de bail et caution, compte et sessions, super admin |

Une route ajoutée demain est **automatiquement** soumise aux matrices de
sécurité et de pagination ; la matrice IDOR échoue tant qu'elle ne sait pas
lui fournir d'identifiants — aucune route paramétrée ne peut passer inaperçue.

## 5. Règles d'écriture

- Tester le comportement observable (réponse + base), pas l'implémentation.
- Un test qui révèle un bug : **on corrige le backend**, jamais le test.
- Toujours au moins un cas d'échec par règle métier.
- Noms de tests en français, décrivant la règle (§ du cahier des charges).
- Aucune attente arbitraire (`sleep`) : les courses sont provoquées par `Promise.all`.
