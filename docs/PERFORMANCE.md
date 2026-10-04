# Audit de performance — N+1, requêtes SQL, charge

Audit réalisé le 4 octobre 2026 sur le backend complet (118 routes de lecture,
8 tâches planifiées). Tout est **rejouable** : les outils sont dans le dépôt
(`src/__tests__/integration/performance/`, `scripts/perf/`).

## 1. Résumé

| Question | Réponse | Preuve |
|---|---|---|
| Y a-t-il des requêtes N+1 sur les routes de lecture ? | **Non** — chaque route coûte 1 à 7 requêtes SQL, que le compte ait 1 ou 40 éléments | test automatique sur les 117 routes GET (`npm run test:performance`) |
| Y en a-t-il dans les tâches planifiées ? | **Oui, une — corrigée** : le job quotidien des échéances faisait ~3 requêtes par bail actif | 550 baux : 1 753 requêtes → **3** |
| Les requêtes SQL tiennent-elles le volume ? | **Oui, après 3 index** ajoutés (migration `20261004000013`) | 13 750 échéances : toutes les routes < 40 ms ; 53 000 échéances / 500 000 lignes d'audit : toutes < 100 ms |
| 50 propriétaires + 50 locataires connectés en même temps ? | **Oui** : p50 20 ms, p95 96–126 ms, 0 erreur | test de charge réel (serveur HTTP, 60 s) |
| Où est la limite ? | ~150 utilisateurs **actifs simultanés** sur le PC de test (8 Go, tout sur la même machine) ; le facteur limitant est le CPU de Node (ORM), pas PostgreSQL | profil CPU sous charge |

## 2. Détection des N+1 (test automatique)

`src/__tests__/integration/performance/n-plus-un.test.js` compte **chaque
aller-retour SQL** (hook `afterQuery` de Sequelize) émis par chaque route GET de
l'API, lue sur le routeur réel — une route ajoutée demain est contrôlée d'office.

1. **Petit compte contre gros compte** : le même jeu de données ×4 sur un
   propriétaire, plus des enfants sous les ressources consultées en détail
   (appartements d'un immeuble, allocations d'un paiement, photos d'un chantier,
   messages d'un fil, incidents, documents). Une route qui fait plus de requêtes
   sur le gros compte échoue, avec les requêtes répétées en cause.
2. **Listes paginées** : `?limit=1` contre `?limit=100` sur le même compte.
3. **Budget** : aucune lecture ne dépasse 25 requêtes.
4. **Contrôle du contrôle** : un N+1 volontaire doit être détecté (sinon un
   compteur cassé laisserait tout passer).

Résultat : **117 routes sur 117 constantes** (1 à 7 requêtes : authentification,
données, total de pagination). Le tableau de bord et ses graphiques : 1 requête.

## 3. Requêtes SQL sur volume

### Bases de volume

| Base | Contenu | Construction |
|---|---|---|
| `gestion_imo_perf_test` | 51 propriétaires (dont 1 à 200 baux), 550 baux, **13 750 échéances**, 5 520 quittances PDF, 460 paiements, 9 000 lignes d'audit | `npm run perf:peupler` (~6 min) — par les **vraies routes** de l'API |
| `gestion_imo_perf_x10_test` | projection plusieurs années : **53 000 échéances pour un seul compte**, **500 000 lignes** de journal d'audit, 15 000 mouvements de caisse et notifications | `npm run perf:amplifier` (SQL direct) |

### Méthode (`npm run perf:audit [-- --base …]`)

Chaque route GET est appelée 5 fois (après échauffement) avec le compte concerné
(gros propriétaire, propriétaire courant, locataire, super admin) ; chaque
requête SQL est chronométrée ; les 40 plus lentes passent en
`EXPLAIN (ANALYZE, BUFFERS)`. Un parcours séquentiel est signalé **seulement**
s'il écarte l'essentiel de ce qu'il lit, ou s'il lit une table entière pour
n'en rendre qu'une page (quand un compte possède 90 % d'une table, la lire en
entier EST le bon plan). Code de sortie ≠ 0 si une route dépasse 150 ms.

### Problèmes trouvés et corrigés

| # | Constat | Effet mesuré | Correction |
|---|---|---|---|
| P1 | **Job `echeances` (N+1)** : la présélection retenait tout bail dont la dernière période précédait l'horizon de 12 mois, alors que la suivante tombait après → chaque nuit, une transaction avec verrou **par bail actif** pour ne rien générer | 550 baux : 1 753 requêtes, 1,7 s ; 10 000 baux ≈ 30 000 requêtes | présélection exacte (prochaine période = dernière + périodicité, comme le calcul JS) — `echeance.service.js` · **3 requêtes**, 0,08 s · test `horizon-echeances.test.js` |
| P2 | **Liste des échéances** : tri par défaut `(due_date, id)` sans index adapté (l'index `(owner_id, status, due_date)` ne sert que filtré par statut) → tri de **toutes** les échéances du compte pour une page | 53 000 échéances : 165 ms la page, linéaire | index `rent_schedules (owner_id, due_date, id)` · **1,5 ms** |
| P3 | **Journal d'audit (super admin)** : tri global par date sans index → tri de la table entière à chaque page | 500 000 lignes : 204 ms la page | index `audit_logs (created_at DESC, id DESC)` · **0,4 ms** |
| P4 | **Rapports financier / rentabilité** : les « autres revenus » (catégorie rare) lisaient tous les mouvements de caisse du compte pour n'en garder aucun | 15 550 lignes lues → 0 gardée | index partiel `cash_movements (owner_id, occurred_on) WHERE category = 'autre_revenu' AND cancelled_at IS NULL` |
| P5 | **Vérification du JWT à chaque requête** : avec un secret en chaîne, `jsonwebtoken` tente `createPublicKey` (échec → exception) avant `createSecretKey` | 3 % du CPU de l'API | clé HMAC préparée une fois (`cleHmac`, `config/security.js`) |
| P6 | **`aujourdhui()`** reconstruisait un `Intl.DateTimeFormat` (données de fuseau) à chaque appel | ~1 % du CPU | formateur unique (`utils/dates.js`) |

P5 + P6 : **+21 % de débit** sur un processus (117 → 142 req/s en saturation).

Les index sont créés `CONCURRENTLY` (hors transaction) : en production, ces
tables sont les plus grosses, un `CREATE INDEX` classique y bloquerait les
encaissements pendant sa construction.

### Résultats après correction

| Base | Routes | Médiane | Plus lente | Requêtes SQL max | Parcours suspects |
|---|---|---|---|---|---|
| volume (13 750 échéances) | 157 mesures | 14 ms | 36 ms | 7 | 0 |
| amplifiée (61 750 échéances, 500 000 audits) | 157 mesures | 14 ms | 95 ms (journal d'audit) | 7 | 0 |

Tâches planifiées sur la base de volume : toutes < 100 ms, 1 à 5 requêtes
chacune (relances, cautions, abonnements… sont des requêtes ensemblistes par
lots ; aucune boucle par ligne).

## 4. Test de charge

`npm run perf:charge -- [--duree 60] [--reflexion-ms 1000] [--processus 4] [--multiplicateur 1] [--profil]`

Le **vrai serveur HTTP** (`src/server.js`, processus séparé, ou cluster de N
processus comme PM2) sur la base de volume. Chaque propriétaire de la base
(51) et un locataire par propriétaire (50) se connectent, puis enchaînent des
écrans selon un mélange d'usage du mobile : tableau de bord 15 %, échéances
15 %, listes 10 %, notifications 10 %, paiements/quittances 10 %, recherche,
caisse, rapports, détail de bail, dépenses, **encaissement en espèces avec
quittance PDF** 3 % (côté locataire : accueil, échéances, quittances,
messagerie). Démarrage étalé sur 2 s, 5 s d'échauffement non mesurées.

Machine de test : PC Windows 8 Go / 8 cœurs logiques, **PostgreSQL, serveur et
générateur de charge sur la même machine** (résultats pessimistes par rapport
à un serveur dédié).

### Usage réaliste (0,5 à 1,5 s entre deux écrans)

| Utilisateurs actifs simultanés | Processus API | Débit | p50 | p95 | p99 | Erreurs |
|---|---|---|---|---|---|---|
| 101 (51 propriétaires + 50 locataires) | 1 | 96 req/s | 21 ms | 126 ms | 207 ms | 0 |
| 101 | 4 | 96 req/s | 20 ms | 96 ms | 231 ms | 0 |
| 202 | 4 | 153 req/s | 95 ms | 677 ms | 1,2 s | 0 |
| 303 | 4 | 196 req/s | 312 ms | 1,2 s | 2,3 s | 0 |

### Saturation (aucune pause entre les écrans, 101 utilisateurs)

| Processus API | Débit | p50 | p95 | Erreurs | Mémoire |
|---|---|---|---|---|---|
| 1 (avant P5/P6) | 117 req/s | 709 ms | 1,3 s | 0 | 147 → 336 Mo |
| 1 (après) | 142 req/s | 605 ms | 1,2 s | 0 | 147 → 336 Mo |
| 4 | 261 req/s | 290 ms | 778 ms | 0 | 4 × ~150 → ~900 Mo au total |

Aucune erreur 5xx, aucun délai d'attente du pool de connexions, mémoire stable
(pas de fuite sur la durée du test).

### Où part le temps (profil CPU sous charge, `--profil`)

Le serveur est **limité par le CPU de Node**, pas par PostgreSQL (la requête la
plus lourde d'une page s'exécute en 1–2 ms côté base) : Sequelize + lodash
≈ 46 % (construction des requêtes, instanciation des modèles), sérialisation
JSON, Express. C'est le coût normal d'un ORM ; la réponse est le **mode
cluster** (un processus par cœur, `ecosystem.config.js` : `instances: 'max'`) :
×1,8 avec 4 processus sur cette machine partagée.

### Lecture pour la production

- 50 propriétaires connectés **ne sont pas** 50 utilisateurs qui cliquent en
  permanence : 101 utilisateurs actifs à un écran par seconde représentent déjà
  ~100 req/s — servis ici avec un p95 de 96 ms.
- Un serveur dédié 2 vCPU / 4 Go (2 processus PM2, PostgreSQL à part) doit
  tenir **au moins** le premier palier ; à rejouer sur le serveur de
  pré-production avant l'ouverture (`npm run perf:peupler` puis `perf:charge`).
- Encaissements : la numérotation des quittances est **séquentielle par
  propriétaire** (verrou volontaire, obligation comptable) — deux encaissements
  simultanés d'un même compte s'attendent (~75 ms chacun, PDF 6–11 ms compris).

## 5. Limites connues (non bloquantes)

- **Total exact du journal d'audit** : `count(*)` sur toute la table (≈ 95 ms à
  500 000 lignes, linéaire). Le journal est immuable (pas de purge) : prévoir
  une politique d'archivage (partitionnement par année) avec la politique de
  conservation CDP, au-delà de quelques millions de lignes.
- **Totaux de pagination** : chaque liste compte toutes les lignes du compte
  (30 ms pour 53 000 échéances). Acceptable ; un compte à plusieurs centaines de
  milliers de lignes justifierait un total estimé.
- La génération des quittances PDF reste dans le processus API (6–11 ms par
  quittance) : négligeable aujourd'hui ; un très gros import de paiements
  gagnerait à passer par une file de travail.
- Résultats mesurés sous Windows (PM2 tourne sous Linux en production :
  répartition des connexions en tourniquet, que `scripts/perf/cluster-serveur.js`
  reproduit).

## 6. Rejouer l'audit

```bash
npm test                      # construit la base de test modèle (une fois)
npm run test:performance      # N+1 sur toutes les routes + job des échéances
npm run perf:peupler          # base de volume (~6 min)
npm run perf:audit            # temps, SQL, EXPLAIN, jobs → tmp/perf-audit-sql-*.json
npm run perf:amplifier        # projection plusieurs années
npm run perf:audit -- --base gestion_imo_perf_x10_test
npm run perf:charge -- --duree 60 --reflexion-ms 1000 --processus 4
```
