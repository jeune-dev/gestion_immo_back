# Analyse du cahier des charges → architecture backend

Document de référence : *Cahier des charges — SaaS de gestion immobilière, V1.1 (23/09/2026)*.
Ce fichier trace **chaque section du cahier des charges** vers les tables, services,
routes et tests qui la réalisent. Il est la carte du projet : toute évolution
fonctionnelle doit commencer par lui.

---

## 1. Périmètre (§ 2, § 3, § 49)

| Plateforme | Acteur | Accès backend |
|---|---|---|
| Mobile | Propriétaire | `/api/v1/*` (routes métier, portée = son patrimoine) |
| Mobile | Locataire | `/api/v1/locataire/*` (portée = ses baux uniquement) |
| Web | Super Admin | `/api/v1/admin/*` |

Hors V1 (§ 3, § 47) : agence, gestionnaire, marketplace, signature électronique,
SMS, comptabilité SYSCOHADA. **Règle d'architecture § 49** : le schéma est prêt à
les accueillir sans réécriture — voir § 3 ci-dessous (table `owner_members`).

---

## 2. Modules et sous-modules

| § CDC | Module backend (`src/modules/…`) | Préfixe de route |
|---|---|---|
| 5 | `auth` (inscription, connexion, refresh, mot de passe oublié, activation locataire) | `/auth` |
| 5, 32 | `compte` (profil, changement de mot de passe, sessions, déconnexion distante, appareils push) | `/compte` |
| 6, 48 | `dashboard` | `/dashboard` |
| 7 | `immeuble` | `/immeubles` |
| 8 | `appartement` (+ historique § 25, rentabilité § 4.21) | `/appartements` |
| 9 | `locataire` (+ invitation § 5 options A/B) | `/locataires` |
| 10, 53 | `bail` (contrat, activation, fin, clôture) + `modeleBail` (génération OHADA) | `/baux` |
| 11 | `loyer` (échéances) | `/echeances` |
| 12, 51 | `paiement` (espèces, Wave/Orange Money intégré, preuve, rapprochement, remboursement) | `/paiements`, `/webhooks` |
| 13 | `quittance` | `/quittances` |
| 14, 54.2 | `relance` (job) + `notification` | — |
| 15–17 | `charge` (factures communes, répartition, charges locataires) | `/factures-communes`, `/charges` |
| 18–19 | `travaux` (+ photos avant/pendant/après) | `/travaux` |
| 20 | `depense` (+ catégories) | `/depenses`, `/categories-depenses` |
| 21 | `caisse` | `/caisse` |
| 22–23 | `incident` | `/incidents` |
| 24 | `artisan` | `/artisans` |
| 26 | `rapport` | `/rapports` |
| 27 | `notification` | `/notifications` |
| 28 | `espaceLocataire` | `/locataire` |
| 29–31 | `admin`, `abonnement` | `/admin`, `/abonnement` |
| 40 | `audit` (service transverse + consultation admin) | `/admin/journal-audit` |
| 52 | `etatDesLieux` | `/etats-des-lieux` |
| 54.1 | `messagerie` | `/messagerie` |
| 55 | `caution` | `/cautions` |
| transverse | `document` (stockage objet, miniatures, URL sécurisées) | `/documents` |

---

## 3. Rôles et permissions (§ 3, § 32, § 49)

Deux niveaux, comme dans Widjila :

1. **Rôle plateforme** (`users.role_code`) : `super_admin`, `proprietaire`, `locataire`.
2. **Rôle dans un espace propriétaire** (`owner_members.role_code`) : en V1, le seul
   rôle est `proprietaire` (titulaire). La table existe dès la V1 pour qu'un
   `gestionnaire` ou une `agence` (V2) soient **un rôle de plus dans `roles`**, pas une
   refonte : toutes les données patrimoniales et financières portent `owner_id`, et
   l'accès passe toujours par l'appartenance, jamais par `users.id = owner.user_id`.

Les permissions sont stockées dans `roles.permissions` (tableau) et vérifiées par
`requirePermission('…')`. Catalogue complet : `src/config/permissions.js`.

| Rôle | Permissions |
|---|---|
| super_admin | `admin.*` (tableau de bord, propriétaires, locataires, immeubles, abonnements, paiements, utilisateurs, signalements, paramètres, notifications, catégories, plans, modèles de bail, modèles WhatsApp, journal d'audit) |
| proprietaire | patrimoine, locataires, baux, loyers, paiements (encaisser, valider, rembourser, rapprocher), quittances, charges, dépenses, caisse, travaux, artisans, incidents, états des lieux, cautions, messagerie, documents, rapports, dashboard, abonnement |
| locataire | `locataire.*` : logement, loyers, charges, paiements, quittances, incidents (signaler), états des lieux (répondre), cautions (contester), messagerie, documents partagés, consentement WhatsApp |

**Contrôle d'accès horizontal (§ 32, § 43)** : toute ressource est chargée par son
identifiant puis comparée à l'espace de l'appelant (`src/utils/acces.js`) :
- inexistante → **404** ;
- existante mais d'un autre propriétaire → **403 Forbidden** (exigence explicite
  du test critique § 43).

Le locataire n'accède qu'aux ressources rattachées à ses fiches `tenants`
(`tenants.user_id = moi`) ; il ne voit jamais un autre locataire (§ 28).

---

## 4. Entités et relations (§ 39)

```
users ─┬─ owner_members ── owners ─┬─ subscriptions ── subscription_plans
       │                           ├─ buildings ── apartments
       │                           ├─ tenants ─── leases ──┬─ rent_schedules ── payment_allocations ── rent_payments
       │                           │   (user_id)           ├─ lease_documents ── lease_templates
       │                           │                       ├─ deposits ── deposit_transactions
       │                           │                       ├─ inspections ── inspection_rooms ── inspection_items ── inspection_photos
       │                           │                       └─ charges (lignes refacturées)
       │                           ├─ charge_invoices ── charge_allocations ── charges
       │                           ├─ payment_providers, payment_transactions, reconciliation_entries, receipts
       │                           ├─ expenses ── expense_categories ; cash_movements
       │                           ├─ contractors ; work_orders ── work_order_events, work_photos ; incidents
       │                           ├─ message_threads ── messages
       │                           └─ documents (polymorphe : entity_type / entity_id)
       ├─ refresh_tokens, password_resets, device_tokens, notifications
       └─ audit_logs, message_deliveries, whatsapp_templates, platform_settings, idempotency_keys, counters
```

Toutes les tables du § 39 existent, avec les mêmes noms. Tables techniques
ajoutées : `owner_members` (évolutivité § 49), `refresh_tokens`, `password_resets`,
`tenant_invitations`, `device_tokens`, `work_order_events` (historique § 41),
`payment_allocations` (paiements partiels / multi-échéances § 51.3),
`rent_reminders` (une relance par échéance et par délai), `subscription_payments`,
`platform_settings`, `idempotency_keys` (double clic, synchronisation différée § 34),
`counters` (numérotation lisible : travaux #00482, quittances, références).

---

## 5. Statuts et transitions

| Entité | Statuts | Transitions (service) |
|---|---|---|
| Appartement (§ 8) | disponible, occupe, en_travaux, indisponible | `occupe` UNIQUEMENT par activation d'un bail ; retour à `disponible` UNIQUEMENT par fin de bail. Changement manuel interdit tant qu'un bail est actif. |
| Bail (§ 10) | brouillon → actif → termine → clos ; brouillon → annule | activation : appartement libre, état des lieux d'entrée (§ 52.4, politique configurable), génération des échéances, caution « attendue ». Clôture : caution restituée ou litige documenté (§ 55.4). |
| Échéance (§ 11) | a_venir, a_payer, partiellement_paye, paye, en_retard, annule | `paye` UNIQUEMENT via une allocation de paiement valide (§ 41). Job quotidien : a_venir → a_payer → en_retard. Remboursement : l'échéance est rouverte (§ 51.4). |
| Transaction (§ 51.4) | initiee → en_attente → confirmee / a_rapprocher / echouee / annulee ; confirmee → remboursee | confirmation SEULEMENT par webhook signé ou validation propriétaire (§ 12). Idempotence sur l'identifiant fournisseur. |
| Travaux (§ 18) | signale → a_valider → valide → artisan_assigne → en_cours → termine ; annule | table de transitions `src/config/transitions.js` ; chaque transition historisée (`work_order_events`). Un travail terminé est immuable (§ 41). |
| Incident (§ 23) | signale → en_analyse → travaux_planifies → resolu ; rejete | la clôture du travail lié résout l'incident et notifie le locataire (§ 54.2). |
| État des lieux (§ 52) | brouillon → soumis → accepte / conteste ; remplace | accepté = verrouillé ; correction = nouvelle version (§ 56.1) ; acceptation tacite à l'échéance du délai configurable. |
| Caution (§ 55.2) | attendue, partiellement_versee, detenue, restitution_en_cours, retenue_partielle, restituee, litige | recalcul à chaque mouvement ; retenue sans motif ni justificatif refusée ; contestation → litige. |
| Facture commune (§ 16) | brouillon → repartie ; annulee | méthode de répartition obligatoire (§ 41). |
| Abonnement (§ 31) | essai, actif, expire, suspendu, annule | job d'expiration ; limites immeubles/appartements/WhatsApp par plan. |

---

## 6. Règles métier (§ 41, § 51.3, § 52.4, § 55.4, § 56.1)

| Règle | Où elle est garantie |
|---|---|
| Un appartement occupé a un locataire actif | `bail.service` (transactions + verrou de ligne) ; index unique partiel « un seul bail actif par appartement » |
| Un loyer n'est PAYÉ qu'avec un paiement valide | `paiement/allocation.service` (seul chemin qui modifie `amount_paid`) ; CHECK `amount_paid <= amount_due` |
| Facture commune avec méthode de répartition | `allocation_method NOT NULL` + CHECK ; méthode et base de calcul conservées par ligne (`charge_allocations.explanation`) |
| Dépense liée à un immeuble, éventuellement à un appartement | `expenses.building_id NOT NULL` + contrôle d'appartenance de l'appartement à l'immeuble |
| Dépense en espèces enregistrée dans la caisse | toute dépense crée son mouvement de caisse dans la même transaction |
| Intervention terminée conserve son historique | `work_order_events`, statut terminal immuable, photos non supprimables |
| Suppression financière logique | aucune suppression physique : `deleted_at` (paranoid) ou statut `annule(e)` |
| Référence unique par demande de paiement | `payment_transactions.reference` UNIQUE |
| Rapprochement : référence, puis montant + numéro payeur | `paiement/rapprochement.service` |
| Montant exact → PAYÉ + quittance ; inférieur → partiel ; supérieur → crédit après confirmation propriétaire | `rapprochement.service` + `reconciliation_entries(type='excedent')` |
| Paiement non identifiable → file « À rapprocher » | `reconciliation_entries(type='non_identifie')` |
| Confirmation reçue deux fois → traitée une fois | UNIQUE (`provider`, `provider_transaction_id`) + verrou de ligne + statut |
| État des lieux accepté immuable | contrôle service + `locked_at` ; correction = nouvelle version (`previous_version_id`) |
| État des lieux d'entrée avant « Occupé » | politique `entry_inspection_policy` (bloquant / avertissement / désactivé) |
| Bail généré depuis une version de modèle conservée | `lease_documents.template_id` + contenu figé (`content`) |
| Aucun WhatsApp sans consentement | `notification/dispatch.service` vérifie `tenants.whatsapp_consent` à chaque envoi |
| Caution exclue des revenus | `cash_movements.is_deposit = true`, exclu des agrégats de revenus/rentabilité |
| Bail clôturé seulement si caution restituée ou litige documenté | `bail.service.cloturer` |

---

## 7. Notifications, fichiers, historique, rapports

- **Notifications (§ 27)** : nouveau paiement, retard, facture, incident, nouveau
  travail, travail terminé, dépense, échéance, document disponible, nouveau message,
  caution. Canaux : notification interne (toujours), push FCM, WhatsApp (modèles
  pré-approuvés, consentement, quota par plan), ordre de repli configurable (§ 54.3).
  Chaque envoi est journalisé dans `message_deliveries` (§ 54.3).
- **Fichiers (§ 7, 19, 20, 22, 37, 52)** : stockage objet (Cloudflare R2, repli disque
  en développement), type réel vérifié par signature binaire, miniature WebP générée
  côté serveur, accès uniquement via l'API après contrôle des droits (URL signée
  courte en option).
- **Historique (§ 25)** : chronologie par appartement et par locataire, reconstruite
  à partir des données financières et opérationnelles (jamais supprimées).
- **Journal d'audit (§ 40)** : écrit par les services dans la MÊME transaction que
  l'action (création, modification, suppression, paiement, remboursement,
  changement de statut, ajout de document, modification de loyer).
- **Rapports (§ 26)** : financier, immobilier, travaux, locataires ; filtres période
  et immeuble ; rentabilité par appartement (§ 4.21, § 48).

---

## 8. Hors ligne et synchronisation (§ 34, § 35, § 44)

- Paiement : jamais hors ligne (confirmation serveur obligatoire).
- Création différée (dépenses, incidents, états des lieux, photos) : en-tête
  `Idempotency-Key` — un renvoi après coupure réseau rejoue la réponse d'origine au
  lieu de créer un doublon ; le double clic est couvert de la même façon.
- Photos d'état des lieux : `captured_at` (prise de vue, fourni par le mobile) ET
  horodatage serveur (`created_at`) sont conservés (§ 52.4).

---

## 9. Points à trancher hors du code (§ 51.5, § 53.5)

- **Fournisseur de paiement** : intégration **PayDunya** (agrégateur : Wave,
  Orange Money, Free Money, carte…, API « Paiement Avec Redirection ») et API Wave
  Checkout directe. Chaque IPN PayDunya est authentifiée par l'empreinte SHA-512
  de la clé principale PUIS vérifiée en relisant la facture chez PayDunya
  (`checkout-invoice/confirm`) : statut et montant ne sont jamais lus dans l'IPN. Les
  identifiants sont **par propriétaire** (`payment_providers`) : les fonds arrivent
  sur le compte du propriétaire, la plateforme ne détient pas les loyers.
- **Modèles de bail** : livrés au statut `brouillon`. Ils doivent être relus par un
  juriste sénégalais puis publiés par le Super Admin avant toute génération (§ 53.5).
- **Modèles WhatsApp** : leurs noms doivent correspondre aux modèles approuvés dans
  le compte WhatsApp Business ; ils sont désactivés tant que le Super Admin ne les
  active pas.
