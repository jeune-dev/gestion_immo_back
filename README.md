# Gestion Immo — API backend

Backend du SaaS de gestion immobilière (cahier des charges V1.1) : application
mobile Propriétaire / Locataire et web Super Admin.

**Node.js 22 · Express 5 · PostgreSQL 16+ · Sequelize 6 · Joi · JWT · Redis (optionnel) · Cloudflare R2 · FCM · WhatsApp Cloud API · PayDunya / Wave**

Architecture reprise de **Widjila** (modules `route → controller → service`,
sécurité, supervision, déploiement) et de **Sign** (même socle technique et
même chaîne de déploiement VPS).

| Document | Contenu |
|---|---|
| [docs/ANALYSE_CAHIER_DES_CHARGES.md](docs/ANALYSE_CAHIER_DES_CHARGES.md) | Traçabilité cahier des charges → modules, tables, rôles, règles, statuts |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | Règles d'écriture du code (accès, transactions, audit, tests) |
| [docs/API.md](docs/API.md) | Référence des 262 routes, générée depuis le code |

---

## 1. Démarrage rapide (développement)

Prérequis : Node.js ≥ 20 (22 recommandé), PostgreSQL ≥ 14 (extension `pg_trgm`
disponible), Redis facultatif.

```bash
npm ci
cp .env.example .env        # puis compléter (voir § 3)
npm run migrate             # schéma
npm run seed                # données de référence : plans, catégories, modèles
npm run init                # rôles + super admin (ADMIN_EMAIL / ADMIN_PASSWORD)
npm run dev                 # http://localhost:3000/health
```

Avec Docker (PostgreSQL + Redis + API) : `docker compose up --build`.

## 2. Structure

```
src/
  app.js, server.js, routes.js   application, démarrage/arrêt propre, registre des routes
  config/        sécurité, base, énumérations, permissions, transitions, paramètres
  middlewares/   auth, accès (rôles/permissions/espaces), abonnement, validation,
                 pagination, idempotence, upload, limites de débit, erreurs
  modules/<m>/   route · controller · service · validation (un dossier par domaine)
  models/        modèles Sequelize (reflet exact des migrations) + associations
  migrations/    schéma SQL : contraintes, CHECK, index partiels
  seeders/       plans, catégories, modèles WhatsApp et de bail, paramètres
  infrastructure/ stockage R2/disque, images, PDF, e-mail, push, WhatsApp, PayDunya, Wave
  jobs/          tâches planifiées (échéances, relances, expirations, nettoyage)
  utils/         journalisation, cache, dates, montants, accès, chiffrement…
  __tests__/     unit/ et integration/ (PostgreSQL réel)
deploy/          nginx, sauvegarde/restauration, déploiement, préparation du VPS
```

Modules : `auth`, `compte`, `dashboard`, `immeuble`, `appartement`, `locataire`,
`bail`, `loyer`, `paiement`, `quittance`, `charge`, `depense`, `caisse`,
`travaux`, `artisan`, `incident`, `etatDesLieux`, `caution`, `messagerie`,
`document`, `notification`, `rapport`, `parametres`, `abonnement`,
`espaceLocataire`, `admin`, `webhook`, `referentiel`, `audit`.

## 3. Configuration

Toutes les variables sont décrites dans **`.env.example`**. Obligatoires :

| Variable | Rôle |
|---|---|
| `DB_*` | Connexion PostgreSQL (`DB_SSL_CA` si base distante TLS) |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Secrets distincts, ≥ 32 caractères en production |
| `APP_ENC_KEY` | Clé AES-256 (base64, 32 octets) : pièces d'identité, clés PayDunya/Wave des propriétaires |
| `INVITATION_SECRET` | HMAC des codes d'invitation locataire |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Super admin initial (politique : 12+ car., 4 classes) |
| `CORS_ORIGIN` | Origines du web admin (`*` refusé en production) |
| `API_PUBLIC_URL`, `APP_PUBLIC_URL` | URLs des webhooks et des retours de paiement |

Facultatives mais recommandées en production : `REDIS_URL` (limites de débit
partagées entre workers), `R2_*` (stockage objet), `RESEND_API_KEY`,
`FIREBASE_SERVICE_ACCOUNT_JSON`, `WHATSAPP_*`, `PAYDUNYA_*` (abonnements),
`METRICS_TOKEN`. Sans elles l'application fonctionne en mode dégradé explicite
(disque local, pas d'e-mail/push/WhatsApp) et le journalise au démarrage.

L'application **refuse de démarrer** en production si un secret manque, si les
secrets JWT sont identiques ou trop courts, ou si `CORS_ORIGIN=*`.

## 4. Base de données

```bash
npm run migrate          # applique les migrations (idempotent)
npm run migrate:status
npm run migrate:undo     # annule la dernière
npm run seed             # seeders de référence (idempotents, jamais d'écrasement)
npm run init             # synchronise les rôles/permissions du code + super admin
```

Le schéma n'est **jamais** modifié par `sequelize.sync()` : les migrations sont
la seule source de vérité. Invariants garantis par la base : montants positifs,
une échéance ne peut pas être « plus que payée », un seul bail actif par
appartement, une confirmation de paiement comptée une seule fois, retenue de
caution impossible sans justificatif, etc. (voir `src/migrations`).

## 5. Tests

Les tests d'intégration utilisent une **vraie base PostgreSQL** définie dans
`.env.test` (copie de `.env` avec `DB_NAME` contenant « test ») ; elle est
recréée à chaque exécution.

```bash
npm test                      # tout (unit + integration), séquentiel
npm run test:unit
npm run test:integration
npx jest --runInBand --runTestsByPath src/__tests__/integration/paiement.test.js
```

19 suites / 221 tests : authentification et sessions, contrôle d'accès
(test critique § 43 : propriétaire A → appartement de B = 403), patrimoine,
baux, échéances, paiements (espèces, preuve, PayDunya, Wave, webhook reçu deux
fois, excédent, montant partiel, non identifié, double clic), quittances,
cautions, charges et répartition, dépenses, caisse, travaux, incidents, états
des lieux, messagerie, documents, notifications, rapports, dashboard, admin,
abonnements.

### Performance

Audit complet (N+1, SQL sur volume, charge) : **[docs/PERFORMANCE.md](docs/PERFORMANCE.md)**.

```bash
npm run test:performance      # aucune route ne fait de requête SQL par ligne (N+1)
npm run perf:peupler          # base de volume : 51 propriétaires, 13 750 échéances
npm run perf:audit            # temps de chaque route, EXPLAIN des requêtes lentes, jobs
npm run perf:charge -- --duree 60 --reflexion-ms 1000 --processus 4
```

## 6. Production

### Docker (recommandé)

```bash
cp .env.example .env && nano .env      # NODE_ENV=production, secrets, domaines
docker compose -f docker-compose.prod.yml up -d --build
```

Au démarrage du conteneur (`docker-entrypoint.sh`) : attente de PostgreSQL →
migrations → seeders → rôles/super admin → API. Une migration en échec empêche
le démarrage (le healthcheck reste rouge, l'ancienne version continue de servir).

- PostgreSQL et Redis ne sont publiés sur aucun port ; l'API seulement sur `127.0.0.1:3000`.
- Conteneur API en lecture seule, sans capacités, utilisateur non root.
- Journaux JSON avec rotation ; `restart: unless-stopped`.

### VPS (Ubuntu)

Procédure complète (serveur, nginx, Redis, sauvegardes, séquestre des clés,
restauration, tests) : **[docs/EXPLOITATION.md](docs/EXPLOITATION.md)**.

1. `sudo bash deploy/setup-server.sh` (Docker, UFW, fail2ban, nginx, certbot, age, rclone).
2. `.env` depuis `.env.example` (`chmod 600`), dont `REDIS_PASSWORD` (obligatoire),
   `BACKUP_AGE_RECIPIENT` et `BACKUP_RCLONE_REMOTE`.
3. nginx : copier `deploy/nginx.conf` (adapter le domaine) et `deploy/nginx-proxy.conf`
   (dans `/etc/nginx/snippets/gestion-imo-proxy.conf`), puis
   `certbot certonly --nginx -d api.exemple.sn` (TLS Mozilla *intermediate*,
   corps limité à 1 Mo hors téléversements, limitation renforcée sur `/api/v1/auth/`).
4. `deploy/deploy.sh` (pull, sauvegarde, build, redémarrage, vérification `/health`).
5. Sauvegardes : cron quotidien sur `deploy/backup-postgres.sh` — base + fichiers,
   **chiffrées** (age, clé privée hors serveur), empreinte SHA-256, **copie hors site**
   vérifiée (rclone) ; test mensuel `deploy/test-restauration.sh` ; restauration :
   `deploy/restore-postgres.sh -i <clé privée> backups/<fichier>.dump.age`.

Alternative sans Docker : PM2 (`ecosystem.config.js`, un worker par cœur, tâches
planifiées sur le worker 0 seulement) après `npm ci --omit=dev && npm run migrate && npm run seed && npm run init`.

### Supervision

- `GET /health/live` (processus, public), `GET /health` et `/health/ready` (base, stockage, Redis — réservés à l'hôte par nginx).
- `GET /metrics` (JSON ou `?format=prometheus`) avec `Authorization: Bearer $METRICS_TOKEN`.
- Chaque réponse et chaque ligne de journal portent `X-Request-Id`.

### À faire valider avant la mise en service (hors code, cahier § 51.5 et § 53.5)

- **Modèles de bail** : livrés en brouillon ; relecture par un juriste sénégalais, puis publication par le Super Admin.
- **Modèles WhatsApp** : créer et faire approuver les modèles dans le compte WhatsApp Business, reporter leurs noms, puis les activer.
- **Paiements** : ouverture d'un compte **PayDunya Business** (et/ou marchand Wave) par chaque propriétaire — les fonds vont sur LEUR compte — puis création d'une application PayDunya et saisie de ses clés (`master_key`, `private_key`, `token`, mode `live`) dans l'application ; compte PayDunya Business de la plateforme (`PAYDUNYA_*`) pour les abonnements. Tester d'abord en mode `test` avec un client fictif PayDunya.

## 7. Tâches planifiées

| Tâche | Quand | Rôle |
|---|---|---|
| echeances | 00:15 | statuts des échéances et des charges, prolongation de l'horizon (12 mois) |
| relances | 09:00 | J-3, J0, J+3/J+7/J+15 (délais configurables), push puis WhatsApp |
| expiration_paiements | toutes les 10 min | demandes de paiement abandonnées |
| etats_des_lieux | toutes les heures | acceptation tacite au terme du délai de réponse |
| cautions | 08:30 | rappels de restitution échue |
| abonnements | 01:00 | essais / abonnements échus → lecture seule |
| nettoyage | 03:30 | jetons, clés d'idempotence, codes et notifications échus |

Chaque tâche est protégée par un verrou consultatif PostgreSQL (jamais deux exécutions simultanées).
