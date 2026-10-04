# Correctifs de sécurité avant mise en production

Suivi des 10 points issus de l'audit de sécurité (lecture seule) du 2026-09-29.
Chaque point passe à **DONE** une fois corrigé, testé (test de régression qui
échoue sans le correctif) et documenté.

| # | Point | Statut |
|---|---|---|
| 1 | Double authentification (TOTP) obligatoire pour le super admin ; réinitialisation par e-mail désactivée pour ce compte ; politique de mot de passe renforcée maintenue (E1, M3) | **DONE** |
| 2 | Code de réinitialisation : compteur d'essais atomique, limite par identifiant normalisé (E2) | **DONE** |
| 3 | Téléversements : mémoire bornée, limite dédiée (E3) | **DONE** |
| 4 | Secrets de production distincts ; super admin initial créé seulement s'il n'en existe aucun (M1, M2) | **DONE** |
| 5 | Rôle PostgreSQL applicatif limité ; journal d'audit impossible à modifier (M5, M6) | **DONE** |
| 6 | Sauvegardes chiffrées hors site, test de restauration (M7) | **DONE** |
| 7 | Mode test PayDunya refusé en production ; jeton de facture contrôlé pour les loyers (M11) | **DONE** |
| 8 | Alertes minimales, traçage des connexions ; `REDIS_URL` obligatoire en production (M9) | **DONE** |
| 9 | Suite de tests complète réussie | **DONE** |
| 10 | M4, M10, M12, M13 et points faibles (journaux, sessions, Idempotency-Key obligatoire, TLS, CI) | **DONE** |

## Détail des correctifs

### Point 1 — Double authentification du super admin (E1, M3) — DONE

- **TOTP RFC 6238** (`src/utils/totp.js`, sans dépendance) : secret de 160 bits chiffré au repos (AES-256-GCM), tolérance d'un pas de 30 s, **anti-rejeu atomique** (un code ne sert qu'une fois, `users.totp_last_step`), 10 **codes de secours** à usage unique stockés en empreintes SHA-256. Migration `20260929000009-double-authentification.js`.
- **Connexion en deux étapes** : si la double authentification est active, `POST /auth/connexion` ne délivre qu'un jeton intermédiaire de 5 min (clé dérivée, jamais utilisable comme jeton d'accès) ; `POST /auth/mfa` (code ou code de secours) ouvre la session. Chaque code faux compte dans le verrouillage du compte (5 échecs → 15 min) et le mot de passe correct ne remet PAS ce compteur à zéro.
- **Obligatoire pour le super admin** : sans double authentification, son jeton n'ouvre que le profil, le changement de mot de passe et la configuration (`403 MFA_REQUISE` partout ailleurs). Désactivation impossible (`403 MFA_OBLIGATOIRE`). Activation = fermeture de toutes les sessions ouvertes sans second facteur.
- **Configuration** : `POST /compte/mfa/initialiser` (mot de passe redemandé) → secret + URI `otpauth://` (QR code) ; `POST /compte/mfa/activer` (premier code) → codes de secours ; `POST /compte/mfa/desactiver` et `POST /compte/mfa/codes-secours` (mot de passe + code). Facultatif pour propriétaires et locataires.
- **Réinitialisation par e-mail fermée au super admin** (réponse identique, tentative journalisée). Rétablissement par un autre super admin : `POST /admin/utilisateurs/:id/reinitialiser-acces` (mot de passe de l'administrateur + motif) → mot de passe provisoire affiché une fois, double authentification à reconfigurer, sessions fermées.
- **Politique renforcée maintenue** (M3) au changement de mot de passe d'un super admin (`422 MOT_DE_PASSE_TROP_FAIBLE`) ; nouveau mot de passe identique à l'actuel refusé pour tous (`422 MOT_DE_PASSE_IDENTIQUE`).
- **Ré-authentification** : créer un super admin exige le mot de passe de l'administrateur (`current_password`).
- **Tests** : `unit/utils/totp.test.js` (vecteurs officiels RFC 6238), `integration/api/auth/double-authentification.test.js` (16 tests : accès fermé sans MFA, connexion en deux étapes, anti-rejeu, force brute séquentielle et simultanée, jetons falsifiés, codes de secours, désactivation interdite, mot de passe oublié, politique, ré-authentification, rétablissement d'accès). Tous les super admins de test passent par le vrai parcours mot de passe + TOTP.

### Point 2 — Force brute du code de réinitialisation (E2) — DONE

- **Compteur atomique** (`auth.service.reinitialiserMotDePasse`) : l'essai est compté AVANT la comparaison par une seule requête conditionnelle (`UPDATE … SET attempts = attempts + 1 WHERE attempts < max RETURNING`). Démontré : avec l'ancien code (lecture puis incrément), 20 codes faux simultanés étaient TOUS comptés (20 essais) ; désormais jamais plus de 5.
- **Consommation atomique** : un code correct envoyé deux fois simultanément ne réinitialise qu'une fois.
- **Limite par compte visé normalisée** (`rateLimit.middleware.cleCibleOtp`) : `771234567`, `+221771234567`, `00221 77 123 45 67`, `77-123-45-67`… partagent le même quota (même normalisation que la recherche du compte) ; e-mail insensible à la casse.
- **Tests** : `integration/api/auth/reinitialisation.test.js` (20 codes faux simultanés → 5 essais comptés puis bon code refusé ; bon code simultané → une seule réinitialisation), `unit/middlewares/limiteActivation.test.js` (variantes d'écriture → même clé).

### Point 3 — Téléversements (E3) — DONE

- **Mémoire bornée par processus** (`upload.middleware.js`) : chaque envoi multipart réserve sa taille annoncée (plafonnée au maximum de la route) AVANT la lecture du corps ; budget `UPLOAD_MEMOIRE_MAX_MO` (150 Mo) épuisé → `503 TELEVERSEMENTS_SATURES` + `Retry-After: 5`, sans file d'attente. Réservation libérée à la fin de la réponse ou à la coupure (`finish`/`close`).
- **2 envois simultanés par utilisateur** au plus (`UPLOAD_SIMULTANES_PAR_UTILISATEUR`) → `429 TELEVERSEMENTS_SIMULTANES`. Les requêtes JSON sans fichier ne sont pas concernées.
- **Limite de débit dédiée** : `UPLOAD_RATE_LIMIT_MAX` (60) envois / 15 min / utilisateur (store Redis partagé), appliquée aux 8 routes de téléversement.
- Un envoi refusé est **lu et jeté** (jamais stocké) avant la réponse : le client reçoit une erreur claire, pas une coupure réseau. Un fichier plus gros que le plafond ne coûte que ce plafond (multer cesse de stocker).
- **Décodage d'image moins coûteux** (constat F3) : `limitInputPixels` 50 → 24 Mpx, PNG compression 9 → 6.
- **nginx** (point 10) : 1 Mo par défaut, 20 Mo sur les routes d'images/justificatifs, 70 Mo seulement pour les vidéos d'incident, 2 connexions de téléversement simultanées par IP.
- Choix : stockage en mémoire CONSERVÉ mais borné — la détection du type réel, le retrait EXIF et l'empreinte d'idempotence ont besoin des octets ; c'est la mémoire simultanée qui devait être plafonnée.
- **Tests** : `unit/middlewares/upload.memoire.test.js` (budget épuisé → 503 propre, fichier trop gros → 400 propre, envois simultanés → 429, rafale de 8 envois : jamais plus que le budget en mémoire, JSON sans fichier non compté, réservation toujours libérée) ; les 14 fichiers d'intégration des routes de téléversement passent.

### Point 4 — Secrets et super admin initial (M1, M2) — DONE

- **Super admin initial** (`src/scripts/initialiser.js`, exécuté à chaque démarrage) : créé seulement s'il n'existe AUCUN super admin — plus de compte recréé quand l'administrateur a changé d'e-mail. S'il en existe un et que `ADMIN_PASSWORD` est encore dans l'environnement : avertissement « retirez ADMIN_PASSWORD ». E-mail déjà pris par un autre compte : rien créé, erreur journalisée, démarrage non bloqué.
- **Contrôles au démarrage en production** (`config/security.js`) : `APP_ENC_KEY` = exactement 32 octets ; `INVITATION_SECRET` obligatoire (≥ 32 caractères) ; `JWT_SECRET`, `JWT_REFRESH_SECRET`, `INVITATION_SECRET`, `APP_ENC_KEY`, `METRICS_TOKEN` tous DIFFÉRENTS (un secret par usage).
- **`npm run secrets:generer`** (`scripts/generer-secrets.js`) : jeu complet de secrets neufs (JWT, refresh, invitation, clé de chiffrement 32 octets, jeton de métriques, mot de passe Redis hexadécimal, mot de passe d'amorçage conforme à la politique). N'écrit rien sur disque.
- **`.env.test`** : nouvelles valeurs de TEST, plus aucune identique à `.env`.
- Politique de mot de passe extraite dans un module pur (`config/validationMotDePasse.js`).
- **À faire par l'exploitant avant la mise en ligne** : générer les secrets de production avec `npm run secrets:generer` (ne JAMAIS reprendre ceux de `.env`), les poser dans le `.env` du serveur (chmod 600), séquestrer `APP_ENC_KEY` hors serveur, retirer `ADMIN_PASSWORD` après le premier démarrage.
- **Tests** : `integration/api/admin/initialisation.test.js` (4 cas : pas de recréation après changement d'e-mail, création unique s'il n'y a aucun super admin, e-mail pris, mot de passe faible), `unit/config/config.test.js` (5 nouveaux refus de démarrage), `unit/config/generer-secrets.test.js`.

### Point 5 — Rôle PostgreSQL limité, journal d'audit inaltérable (M5, M6) — DONE

- **Deux rôles** : le PROPRIÉTAIRE du schéma (`DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`, superutilisateur de l'image postgres) ne sert qu'au démarrage du conteneur (migrations, données de référence, initialisation) ; l'API tourne avec `DB_USER` / `DB_PASSWORD`, rôle créé et remis à jour à chaque démarrage par `src/scripts/rolesBase.js` : `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, lecture/écriture des données et des séquences, AUCUN droit de schéma, table des migrations en lecture seule, journal d'audit en INSERT + SELECT seulement. `ALTER DEFAULT PRIVILEGES` couvre les tables des futures migrations.
- `docker-entrypoint.sh` exécute les étapes d'amorçage avec le propriétaire puis lance l'API avec le rôle limité ; `docker-compose.prod.yml` exige `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`.
- **Refus de démarrer en production** avec un rôle privilégié (`server.js` → `verifierRoleApplicatif`), sauf dérogation explicite `DB_AUTORISER_SUPERUTILISATEUR=1` (dépannage).
- **Journal d'audit en ajout seul** (migration `20260929000010-journal-audit-immuable.js`) : déclencheurs refusant `UPDATE`, `DELETE` et `TRUNCATE` sur `audit_logs`, pour TOUS les rôles, propriétaire compris (désactiver le déclencheur exige d'être propriétaire et laisse une trace dans les journaux PostgreSQL).
- **Toute la suite de tests tourne désormais avec le rôle applicatif** (globalSetup crée le rôle sur chaque base de worker) : 1 941 / 1 942 tests d'intégration et E2E passent sous privilèges minimaux dès le premier essai ; le seul test concerné (cycle réel d'une migration) utilise désormais la connexion du propriétaire, comme l'entrypoint. Désactivable : `TEST_ROLE_APPLICATIF=0`.
- **Tests** : `integration/postgres/roles-audit.test.js` (21 tests : rôle non privilégié ; 11 opérations interdites avec le code `42501` — modifier/supprimer/vider l'audit, DDL, historique des migrations, `COPY … TO PROGRAM`, `pg_read_file`, créer un rôle ou une base ; refus de démarrer en production avec un rôle privilégié ; `UPDATE`/`DELETE`/`TRUNCATE` de l'audit refusés même au propriétaire ; script idempotent aux droits exacts ; paramètres injectés refusés).
- **À faire par l'exploitant** : renseigner `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` (propriétaire) et `DB_USER` / `DB_PASSWORD` (rôle applicatif, 16 caractères minimum) — `npm run secrets:generer` fournit les mots de passe. Base EXISTANTE : le rôle applicatif est créé au prochain démarrage ; les tables appartiennent au propriétaire.

### Point 6 — Sauvegardes (M7) — DONE

- `deploy/backup-postgres.sh` : base (`pg_dump -Fc`) ET fichiers téléversés chiffrés avec `age` (clé publique ; la clé privée n'est jamais sur le serveur), refus de sauvegarder en clair, empreinte SHA-256, copie hors site `rclone copy --immutable` + `rclone check`, verrou, `umask 077`. `.env` n'est plus exécuté comme un script (`deploy/_commun.sh`).
- `deploy/restore-postgres.sh` : déchiffrement en flux, empreinte vérifiée avant toute écriture, `--single-transaction`.
- `deploy/test-restauration.sh` : restaure la dernière sauvegarde dans une base temporaire, contrôle les tables clés et la dernière migration, supprime la base (exercice mensuel).
- `docs/EXPLOITATION.md` : RPO 24 h / RTO 4 h, rétentions, génération des clés `age`, séquestre hors serveur (deux personnes) de la clé privée, d'`APP_ENC_KEY` et du `.env`, crontab, procédure de restauration, exercice trimestriel.
- Vérifié sur un vrai PostgreSQL 17 + rclone (le binaire `age` n'était pas installé sur le poste : chiffrement simulé pendant ce test).

### Point 7 — Paiements PayDunya (M11) — DONE

- **Mode test interdit en production**, à tous les niveaux (lu à chaque appel, `paydunya.modeTestInterdit()`) :
  - configuration d'un moyen PayDunya actif avec des clés de test → `422 MODE_TEST_INTERDIT` (création comme réactivation) ;
  - initiation d'un paiement sur un moyen resté en mode test → `409 PAIEMENT_INTEGRE_INDISPONIBLE`, aucune facture créée chez PayDunya, erreur journalisée ;
  - facture relue en mode test → notification refusée (401), rien n'est payé ;
  - démarrage refusé si les clés PayDunya de la plateforme ne sont pas en `live`, ou si `PAYDUNYA_BASE_URL` est définie (redirection des appels de paiement).
  - Dérogation explicite de préproduction : `PAIEMENT_MODE_TEST_AUTORISE=1`.
- **Confirmation rattachée à LA transaction** (`rapprochement.traiterConfirmation`) : fournisseur de la notification différent de celui de la transaction, ou jeton de facture différent de celui enregistré à l'initiation → pas d'imputation, file « À rapprocher » (`motif: facture_incoherente`), une seule entrée même si la notification est rejouée. La vraie facture reste imputée normalement.
- **Tests** : `integration/api/paiements/mode-production.test.js` (6 tests : configuration, initiation, notification de test en production, dérogation, facture étrangère portant la référence, notification PayDunya pour une transaction Wave) ; `unit/config/config.test.js` (URL PayDunya redirigée, clés plateforme en test, mode live et dérogation acceptés).

### Point 8 — Alertes et traçage (M9) — DONE

- **Service d'alertes** (`src/infrastructure/alertes.service.js`) : webhook JSON (`ALERT_WEBHOOK_URL`, compatible Slack / Mattermost / Discord / Teams) et/ou e-mail (`ALERT_EMAIL`), anti-répétition par type (15 min), ne lève jamais d'exception. Déclencheurs :
  - arrêt d'un processus sur erreur non gérée (alerte envoyée avant l'arrêt, bornée à 3 s) ;
  - dépendance externe indisponible (ouverture d'un disjoncteur : e-mail, push, PayDunya, stockage…) ;
  - tâche planifiée en échec ;
  - rafale d'erreurs serveur (≥ 20 en une minute, `ALERTE_SEUIL_5XX_MINUTE`) ;
  - rafale de refus par les limites de débit (≥ 200 / min) ;
  - rejeu d'un jeton de session révoqué (vol probable) ;
  - verrouillage d'un compte super admin (mots de passe ou codes TOTP faux).
- **Connexions tracées dans le journal d'audit** : `compte.connexion`, `compte.connexion_echec` (motif : `compte_inconnu`, `mot_de_passe`, `compte_verrouille` ; non imputé au titulaire), `compte.connexion_mot_de_passe_valide` (étape TOTP), `compte.connexion_double_authentification`. L'identifiant tenté n'est jamais écrit en clair (empreinte courte qui regroupe les essais sur un même compte) ; IP et navigateur du contexte.
- **Limites de débit tracées** : chaque refus 429 est journalisé (limiteur, IP, utilisateur, chemin) et compté (`rate_limit.depasse.<limiteur>`), y compris le filet global.
- **Métriques d'erreurs** : chaque erreur est comptée par code (`api_erreurs_total`, jusqu'ici jamais alimentée).
- **Démarrage refusé en production** sans `REDIS_URL` (limites partagées entre processus), sans `METRICS_TOKEN` (≥ 32 caractères) ou sans canal d'alerte.
- **Tests** : `unit/infrastructure/alertes.test.js` (webhook, anti-répétition, e-mail multi-destinataires, pannes de canal, seuil de rafale, ouverture de disjoncteur, 429 journalisé et compté, erreurs comptées par code), `integration/api/auth/tracage-connexions.test.js` (réussite, échec par motif, compte inconnu, verrouillé, étape TOTP ; identifiant jamais en clair), `unit/config/config.test.js` (4 nouveaux refus de démarrage).

### Point 10 — M4, M10, M12, M13 et points faibles — DONE

- **M4 — blocage de compte** : un compte bloqué reçoit la MÊME réponse qu'un mot de passe faux ou un compte inconnu (`401 IDENTIFIANTS_INVALIDES`, même message, même coût bcrypt) — plus d'énumération ni de constat du blocage ; le titulaire se débloque par « mot de passe oublié ».
- **M10 — quittances** : dans la transaction du paiement, seuls le numéro et la ligne de quittance sont créés ; le PDF et son stockage sont produits APRÈS validation (`afterCommit`, aucun verrou tenu), sans jamais faire échouer un paiement réussi ; tâche `quittances_manquantes` (toutes les 10 min) pour le rattrapage ; PDF demandé avant sa production → `503 QUITTANCE_EN_PREPARATION`. Un remboursement concurrent est sérialisé par le verrou de la seule quittance : un PDF annulé n'est jamais partagé.
- **M12 — rapports et exports** : limite dédiée par utilisateur (`RAPPORT_RATE_LIMIT_MAX`, 60 / 15 min) sur les rapports et les PDF d'état des lieux générés à la volée ; export CSV plafonné (`EXPORT_MAX_LIGNES`, 10 000 → `422 EXPORT_TROP_VOLUMINEUX`).
- **M13 — données personnelles** : `tenants.notes`, `payment_transactions.payer_phone` et `reconciliation_entries.payer_phone` chiffrés au repos (AES-256-GCM) ; données existantes chiffrées par la migration `20260929000012` (rejouable). Aucune de ces colonnes ne sert de critère de recherche.
- **Sessions** : durée maximale ABSOLUE (90 jours, super admin 12 heures) conservée de rotation en rotation ; motif de chaque révocation (`revoked_reason`) — seule la réutilisation d'un jeton remplacé par ROTATION déclenche la fermeture de toutes les sessions (un vieux jeton déconnecté ne peut plus déconnecter la victime). Migration `20260929000011`.
- **Idempotency-Key obligatoire** sur les mouvements d'argent (espèces, remboursement, versement, retenue, restitution de caution) → `422 IDEMPOTENCE_REQUISE` sans rien écrire.
- **Journaux** : JSON mal formé journalisé sans le message de `JSON.parse` (qui recopiait un extrait du corps, mot de passe compris) ; un fichier de journal par processus PM2.
- **Configuration** : `CORS_ORIGIN` obligatoire en production et uniquement en `https://` ; vérification du webhook WhatsApp à temps constant sur les octets (plus d'erreur 500 sur caractères multi-octets).
- **Infrastructure** (agent dédié) : TLS nginx profil Mozilla « intermediate », tailles de corps par route (1 / 20 / 70 Mo), limite stricte sur `/api/v1/auth/`, `/health` réservé à l'hôte local, HSTS émis une seule fois ; CI avec `permissions: contents: read`, `npm audit --audit-level=moderate`, gitleaks, Trivy, shellcheck, actions épinglées par SHA, Dependabot ; image Docker sans `curl` ni npm, `--ignore-scripts` sauf bcrypt ; Redis protégé par mot de passe, politique `volatile-lru`.
- **Tests** : `inscription-connexion` (réponses indiscernables bloqué / faux / inconnu), `jetons-sessions` (5 tests : vieux jeton déconnecté, rotation rejouée, durée max, super admin 12 h, motifs), `quittances` (stockage en panne : paiement réussi puis rattrapage ; PDF stocké après validation), `rapports.complet` (plafond d'export), `locataires` (notes chiffrées), `paiements/idempotence-obligatoire` (5 routes sans clé, double envoi avec la même clé), `alertes` (JSON mal formé sans fuite), `webhooks` (multi-octets), `config` (CORS).

### Point 9 — Suite de tests complète — DONE

Exécution finale (2026-09-29) : `JEST_WORKERS=2 npx jest --coverage --randomize` puis `npm run test:routes`.

| Mesure | Résultat |
|---|---|
| Fichiers de test | **111 / 111** réussis |
| Tests | **2 600 / 2 600** réussis, 0 ignoré |
| Exécution | parallèle (2 workers, une base clonée par worker), ordre ALÉATOIRE (graine 694534483), rôle PostgreSQL applicatif à privilèges minimaux |
| Couverture | instructions **95,78 %**, branches **86,16 %**, fonctions **95,29 %**, lignes **96,56 %** — seuils imposés : 94 / 84 / 93 / 95 % |
| Routes | **268 / 268** appelées par les tests (100 %) |

Corrigé en chemin : une course réelle dans le middleware d'idempotence (clé d'un refus passager libérée APRÈS la réponse → libérée avant) ; tests rendus indépendants de l'ordre (état partagé, données plateforme restaurées) ; outil `telephoneUnique()` sans collisions ; sondes `/health*` et `/metrics` désormais testées. Incident externe écarté : l'extension VS Code Console Ninja s'injectait dans les processus de test (voir le rapport).

## Reste hors code (exploitant)

- Générer les secrets de production (`npm run secrets:generer`), renseigner `DB_ADMIN_*`, `DB_*`, `REDIS_PASSWORD`, `METRICS_TOKEN`, `ALERT_WEBHOOK_URL` / `ALERT_EMAIL`, `PAYDUNYA_*` (mode `live`), `CORS_ORIGIN` (https).
- Clés `age` des sauvegardes (clé privée hors serveur), destination `rclone`, crontab (voir `docs/EXPLOITATION.md`).
- Copier le bloc nginx, certificats (`certbot certonly`).
- Conformité CDP (loi 2008-12) : déclaration, registre des traitements, politique de conservation — non traitée par le code (constat M8 de l'audit, hors des 10 points).
