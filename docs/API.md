# Référence de l'API — /api/v1

Générée depuis le routeur réel : `npm run doc:routes` (262 routes).

## Conventions

- **Authentification** : `Authorization: Bearer <access_token>` (15 min). Renouvellement : `POST /api/v1/auth/refresh` avec `refresh_token` (mobile, dans le corps) ou le cookie httpOnly `refresh_token` (web). Rotation à chaque appel.
- **Espaces** : routes propriétaire (compte propriétaire, abonnement actif pour écrire — sinon **402 ABONNEMENT_REQUIS**), `/locataire/*` (compte locataire), `/admin/*` (super admin). Chaque route exige une permission (`src/config/permissions.js`).
- **Accès horizontal** : ressource d'un autre propriétaire / locataire → **403**, inexistante → **404**.
- **Réponse** : `{ success, message, data }` ; listes : `data: { items, pagination: { page, limit, total, totalPages } }` ; `?page=` et `?limit=` (100 max) ; tri `?tri=champ` ou `?tri=-champ` (liste blanche).
- **Erreur** : `{ success: false, message, error: { code, message, details? }, requestId }` — codes HTTP : 400, 401, 402, 403, 404, 409 (état / transition), 413, 422 (validation), 429, 503 (réessayable, en-tête Retry-After).
- **Idempotence** : en-tête `Idempotency-Key` (8–128 car.) sur les créations sensibles ; OBLIGATOIRE (sinon **422 IDEMPOTENCE_REQUISE**) sur les mouvements d'argent : `POST /locataire/paiements`, `POST /paiements/especes`, `POST /paiements/:id/rembourser`, `POST /cautions/:id/versements`, `/retenues`, `/restitutions`. Même clé + même requête → réponse rejouée (`Idempotent-Replayed: true`).
- **Fichiers** : multipart, champ `fichier` ; type réel vérifié par signature binaire ; lecture via `GET /documents/:id/fichier` (`?taille=miniature`).
- **Montants** : FCFA entiers. **Dates** : `AAAA-MM-JJ`. **JSON** : snake_case.
- **Corrélation** : chaque réponse porte `X-Request-Id` (à citer au support).
- **Pagination stricte** : `page` / `limit` non entiers ou < 1 → **422 PAGINATION_INVALIDE** ; `limit` > 100 ramené à 100.

## Règles de sécurité à connaître côté client

| Situation | Réponse |
|---|---|
| Connexion d'un compte à double authentification active (obligatoire pour le super admin) | 200 `{ mfa_requis: true, mfa_token }` (5 min) — puis `POST /auth/mfa` `{ mfa_token, code }` ou `{ mfa_token, code_secours }` → session |
| Super admin sans double authentification configurée | **403 MFA_REQUISE** partout sauf profil, mot de passe, `POST /compte/mfa/initialiser` et `/activer` |
| Désactiver la double authentification d'un super admin | **403 MFA_OBLIGATOIRE** |
| Code TOTP faux, rejoué ou expiré | **401 CODE_MFA_INVALIDE** (compte bloqué 15 min après 5 échecs) |
| Mot de passe oublié pour un super admin | réponse identique, aucun code envoyé — accès rétabli par un autre super admin (`POST /admin/utilisateurs/:id/reinitialiser-acces`) |
| Compte bloqué après des échecs | **401 IDENTIFIANTS_INVALIDES**, message identique à un mot de passe faux (plus de 403 révélateur) |
| Session au-delà de sa durée maximale (90 j ; super admin 12 h) | **401** au rafraîchissement, nouvelle connexion |
| Téléversements : trop d'envois simultanés / serveur saturé | **429 TELEVERSEMENTS_SIMULTANES** / **503 TELEVERSEMENTS_SATURES** (Retry-After) |
| Export CSV au-delà de `EXPORT_MAX_LIGNES` | **422 EXPORT_TROP_VOLUMINEUX** |
| PDF de quittance pas encore produit (juste après le paiement) | **503 QUITTANCE_EN_PREPARATION** (Retry-After : 5) |
| Création d'un super admin sans `current_password` / avec un faux | **422** / **401 MOT_DE_PASSE_INCORRECT** |
| Nouveau mot de passe identique à l'actuel ; super admin trop faible | **422 MOT_DE_PASSE_IDENTIQUE** ; **422 MOT_DE_PASSE_TROP_FAIBLE** |
| Compte à mot de passe provisoire (`must_change_password`) : toute route sauf `GET /compte`, `POST /compte/mot-de-passe`, `POST /auth/deconnexion` | **403 CHANGEMENT_MOT_DE_PASSE_REQUIS** |
| `PATCH /compte` changeant ou retirant l'e-mail sans `current_password` / avec un faux | **422 MOT_DE_PASSE_ACTUEL_REQUIS** / **401 MOT_DE_PASSE_INCORRECT** (l'e-mail repasse non vérifié) |
| `POST /auth/locataire/activation` : 5 essais par invitation (code ou mot de passe du compte existant), limiteur par téléphone | invitation épuisée ; **429** au-delà du limiteur |
| `GET /compte/sessions` : session courante (`current`) | reconnue par le refresh token présenté (`X-Refresh-Token`, mobile) ou, à défaut, par le jeton d'accès (web) |
| Consentement WhatsApp retiré par le locataire, redéclaré par le propriétaire | **409 CONSENTEMENT_RETIRE** (seul le locataire peut le redonner) |
| Désactiver le dernier super admin actif | **409 DERNIER_SUPER_ADMIN** |
| Désactiver / supprimer le plan d'essai (`DELETE /admin/plans/:id`) | **409 PLAN_ESSAI** |
| Visibilité d'une pièce probante (EDL accepté, contrat, reçu, justificatif) modifiée | **409 DOCUMENT_PROTEGE** |
| Retenue sur caution : justificatif hors du dossier du bail / élément d'EDL d'un autre bail | **403 JUSTIFICATIF_INVALIDE** / **422 ELEMENT_ETRANGER** |
| Message rattachant l'incident / l'échéance d'un autre locataire | **403 RATTACHEMENT_REFUSE** |
| Activation d'un bail pour un locataire supprimé | **409 LOCATAIRE_SUPPRIME** |
| Révision de loyer à date d'effet passée | **422 DATE_EFFET_PASSEE** |
| Date au bon format mais inexistante (`2026-02-30`), partout | **422** (plus jamais 500) |
| Encaissement manuel daté dans le futur (`paid_on`) | **422** |
| Annuler une échéance / une facture commune avec un paiement en cours (ou une demande annulée depuis moins de 24 h) | **409 PAIEMENT_EN_COURS** |
| Webhook signé dont la cible a été annulée entre-temps | 200 : paiement enregistré, imputé FIFO sur le bail, surplus en « excédent » |
| Confirmation arrivant après une annulation annoncée par le fournisseur | 200 : file « À rapprocher » (`confirmation_apres_annulation`), jamais marquée PAYÉE d'office |
| IPN PayDunya : empreinte fausse / facture relue incohérente | **401 SIGNATURE_INVALIDE** (abonnement : **400 NOTIFICATION_REFUSEE**) |
| IPN PayDunya pendant une panne de PayDunya (facture impossible à relire) | **503 FOURNISSEUR_INDISPONIBLE** (PayDunya renverra ; rien n'est modifié) |
| Clés PayDunya : clé privée de test en mode `live` (ou l'inverse), clé manquante | **422** ; réactivation d'un moyen sans clés PayDunya : **422 IDENTIFIANTS_REQUIS** |
| Rembourser un paiement déjà remboursé / rejeter un excédent après remboursement | **409 DEJA_REMBOURSE** |
| Paiement en ligne sans `API_PUBLIC_URL` configurée | **503 PAIEMENT_NON_CONFIGURE** |
| `Idempotency-Key` : réponses rejouées | 2xx, 400, 404, 422 seulement ; clé libérée sur 401/402/403/409/429/5xx (on peut réessayer) |
| Autre revenu de caisse : appartement d'un autre immeuble | **422 APPARTEMENT_HORS_IMMEUBLE** |
| Synthèse de caisse à période inversée | **422** |
| Abonnement échu : lectures (`GET` rapports, messagerie…) | autorisées ; écritures **402** |
| Deux synchronisations hors ligne d'un même incident (`client_reference`) | 200 avec la demande existante |

Variables d'exploitation : `RELANCES_TAILLE_LOT` (défaut 1000) — les relances partent par lots ordonnés jusqu'à épuisement.

## Sondes et supervision

| Méthode | Chemin |
|---|---|
| GET | `/health/live` |
| GET | `/health` |
| GET | `/health/ready` |
| GET | `/metrics` |

## Authentification (§ 5) — public

| Méthode | Chemin |
|---|---|
| POST | `/api/v1/auth/inscription` |
| POST | `/api/v1/auth/connexion` |
| POST | `/api/v1/auth/refresh` |
| POST | `/api/v1/auth/deconnexion` |
| POST | `/api/v1/auth/mot-de-passe-oublie` |
| POST | `/api/v1/auth/reinitialiser-mot-de-passe` |
| POST | `/api/v1/auth/locataire/activation` |

## Référentiels — public

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/referentiels` |

## Paiement en ligne PayDunya (§ 31, § 51)

1. **Propriétaire** : compte PayDunya Business → « Intégrez notre API » → application → clés. Puis :
   `PUT /api/v1/paiements/moyens` `{ "provider": "paydunya", "mode": "integre", "credentials": { "master_key": "…", "private_key": "live_private_…", "token": "…", "mode": "live" } }`
   (clés chiffrées en base, jamais relues par l'API ; `mode: "test"` avec les clés de test pour essayer avec un client fictif).
2. **Locataire** : `POST /api/v1/locataire/paiements` `{ rent_schedule_id, wallet: "wave" | "orange_money" }` → facture PayDunya créée (montant, canal restreint au portefeuille, nom du bailleur, référence en `custom_data`) → `checkout_url` à ouvrir.
3. **PayDunya** poste l'IPN (x-www-form-urlencoded, sous `data`) sur `/api/v1/webhooks/paydunya/:id` (URL passée à chaque facture) :
   empreinte `SHA-512(master_key)` vérifiée, puis **facture relue** via `checkout-invoice/confirm/:token` — statut, montant et référence ne viennent QUE de cette relecture. Paiement imputé, quittance générée, IPN reçue deux fois = sans effet.
4. **Abonnements** : même mécanisme avec les clés de la plateforme (`PAYDUNYA_*`), IPN sur `/api/v1/webhooks/abonnement/paydunya`.

## Webhooks fournisseurs — authentifiés

| Méthode | Chemin |
|---|---|
| POST | `/api/v1/webhooks/paydunya/:id` |
| POST | `/api/v1/webhooks/wave/:id` |
| POST | `/api/v1/webhooks/abonnement/paydunya` |
| GET | `/api/v1/webhooks/whatsapp` |
| POST | `/api/v1/webhooks/whatsapp` |

## Compte (tout utilisateur)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/compte` |
| PATCH | `/api/v1/compte` |
| POST | `/api/v1/compte/mot-de-passe` |
| GET | `/api/v1/compte/sessions` |
| DELETE | `/api/v1/compte/sessions/:id` |
| POST | `/api/v1/compte/sessions/revoquer-toutes` |
| POST | `/api/v1/compte/appareils` |
| DELETE | `/api/v1/compte/appareils` |

## Notifications (§ 27)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/notifications` |
| GET | `/api/v1/notifications/compteur` |
| POST | `/api/v1/notifications/tout-lire` |
| POST | `/api/v1/notifications/:id/lue` |

## Documents

| Méthode | Chemin |
|---|---|
| POST | `/api/v1/documents` |
| GET | `/api/v1/documents` |
| GET | `/api/v1/documents/:id/fichier` |
| GET | `/api/v1/documents/:id/lien` |
| PATCH | `/api/v1/documents/:id` |
| DELETE | `/api/v1/documents/:id` |

## Tableau de bord (§ 6, § 48)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/dashboard` |
| GET | `/api/v1/dashboard/graphiques` |

## Immeubles (§ 7)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/immeubles` |
| POST | `/api/v1/immeubles` |
| GET | `/api/v1/immeubles/:id` |
| PATCH | `/api/v1/immeubles/:id` |
| DELETE | `/api/v1/immeubles/:id` |

## Appartements (§ 8, § 25)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/appartements` |
| POST | `/api/v1/appartements` |
| GET | `/api/v1/appartements/:id` |
| PATCH | `/api/v1/appartements/:id` |
| PATCH | `/api/v1/appartements/:id/statut` |
| DELETE | `/api/v1/appartements/:id` |
| GET | `/api/v1/appartements/:id/historique` |
| GET | `/api/v1/appartements/:id/rentabilite` |

## Locataires (§ 9)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/locataires` |
| POST | `/api/v1/locataires` |
| GET | `/api/v1/locataires/:id` |
| PATCH | `/api/v1/locataires/:id` |
| DELETE | `/api/v1/locataires/:id` |
| POST | `/api/v1/locataires/:id/invitation` |
| POST | `/api/v1/locataires/:id/consentement-whatsapp` |

## Baux et contrats (§ 10, § 53)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/baux` |
| POST | `/api/v1/baux` |
| GET | `/api/v1/baux/:id` |
| PATCH | `/api/v1/baux/:id` |
| POST | `/api/v1/baux/:id/activer` |
| POST | `/api/v1/baux/:id/annuler` |
| POST | `/api/v1/baux/:id/terminer` |
| POST | `/api/v1/baux/:id/cloturer` |
| POST | `/api/v1/baux/:id/loyer` |
| GET | `/api/v1/baux/:id/contrats` |
| POST | `/api/v1/baux/:id/contrats` |

## Échéances (§ 11)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/echeances` |
| GET | `/api/v1/echeances/:id` |
| POST | `/api/v1/echeances/:id/annuler` |

## Paiements (§ 12, § 51)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/paiements/transactions` |
| GET | `/api/v1/paiements/transactions/:id` |
| POST | `/api/v1/paiements/transactions/:id/valider` |
| POST | `/api/v1/paiements/transactions/:id/rejeter` |
| GET | `/api/v1/paiements/rapprochements` |
| POST | `/api/v1/paiements/rapprochements/:id/resoudre` |
| POST | `/api/v1/paiements/rapprochements/:id/rejeter` |
| GET | `/api/v1/paiements/moyens` |
| PUT | `/api/v1/paiements/moyens` |
| POST | `/api/v1/paiements/especes` |
| GET | `/api/v1/paiements` |
| GET | `/api/v1/paiements/:id` |
| GET | `/api/v1/paiements/:id/quittances` |
| POST | `/api/v1/paiements/:id/rembourser` |

## Quittances (§ 13)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/quittances` |
| GET | `/api/v1/quittances/:id` |
| GET | `/api/v1/quittances/:id/pdf` |

## Factures communes (§ 16, § 17)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/factures-communes` |
| GET | `/api/v1/factures-communes/a-repartir` |
| POST | `/api/v1/factures-communes` |
| GET | `/api/v1/factures-communes/:id` |
| PATCH | `/api/v1/factures-communes/:id` |
| POST | `/api/v1/factures-communes/:id/document` |
| GET | `/api/v1/factures-communes/:id/apercu` |
| POST | `/api/v1/factures-communes/:id/apercu` |
| POST | `/api/v1/factures-communes/:id/repartir` |
| POST | `/api/v1/factures-communes/:id/annuler` |

## Charges refacturées (§ 15)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/charges` |
| GET | `/api/v1/charges/:id` |

## Dépenses (§ 20)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/depenses` |
| POST | `/api/v1/depenses` |
| GET | `/api/v1/depenses/:id` |
| PATCH | `/api/v1/depenses/:id` |
| POST | `/api/v1/depenses/:id/annuler` |
| POST | `/api/v1/depenses/:id/justificatifs` |

## Catégories de dépenses

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/categories-depenses` |
| POST | `/api/v1/categories-depenses` |
| PATCH | `/api/v1/categories-depenses/:id` |
| POST | `/api/v1/categories-depenses/:id/desactiver` |

## Caisse (§ 21)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/caisse` |
| GET | `/api/v1/caisse/synthese` |
| POST | `/api/v1/caisse/autres-revenus` |
| POST | `/api/v1/caisse/:id/annuler` |

## Travaux (§ 18, § 19)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/travaux` |
| POST | `/api/v1/travaux` |
| GET | `/api/v1/travaux/:id` |
| PATCH | `/api/v1/travaux/:id` |
| POST | `/api/v1/travaux/:id/statut` |
| GET | `/api/v1/travaux/:id/photos` |
| POST | `/api/v1/travaux/:id/photos` |
| DELETE | `/api/v1/travaux/:id/photos/:photoId` |
| POST | `/api/v1/travaux/:id/depenses` |

## Artisans (§ 24)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/artisans` |
| POST | `/api/v1/artisans` |
| GET | `/api/v1/artisans/:id` |
| PATCH | `/api/v1/artisans/:id` |
| POST | `/api/v1/artisans/:id/desactiver` |
| POST | `/api/v1/artisans/:id/reactiver` |
| DELETE | `/api/v1/artisans/:id` |

## Incidents (§ 22, § 23)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/incidents` |
| POST | `/api/v1/incidents` |
| GET | `/api/v1/incidents/:id` |
| POST | `/api/v1/incidents/:id/analyser` |
| POST | `/api/v1/incidents/:id/rejeter` |
| POST | `/api/v1/incidents/:id/resoudre` |
| POST | `/api/v1/incidents/:id/travaux` |

## États des lieux (§ 52)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/etats-des-lieux` |
| POST | `/api/v1/etats-des-lieux` |
| GET | `/api/v1/etats-des-lieux/comparaison` |
| GET | `/api/v1/etats-des-lieux/:id` |
| PATCH | `/api/v1/etats-des-lieux/:id` |
| DELETE | `/api/v1/etats-des-lieux/:id` |
| GET | `/api/v1/etats-des-lieux/:id/pdf` |
| POST | `/api/v1/etats-des-lieux/:id/pieces` |
| PATCH | `/api/v1/etats-des-lieux/:id/pieces/:roomId` |
| DELETE | `/api/v1/etats-des-lieux/:id/pieces/:roomId` |
| POST | `/api/v1/etats-des-lieux/:id/pieces/:roomId/elements` |
| PATCH | `/api/v1/etats-des-lieux/:id/elements/:itemId` |
| DELETE | `/api/v1/etats-des-lieux/:id/elements/:itemId` |
| POST | `/api/v1/etats-des-lieux/:id/elements/:itemId/photos` |
| DELETE | `/api/v1/etats-des-lieux/:id/photos/:photoId` |
| PUT | `/api/v1/etats-des-lieux/:id/saisie` |
| POST | `/api/v1/etats-des-lieux/:id/soumettre` |
| POST | `/api/v1/etats-des-lieux/:id/corriger` |

## Cautions (§ 55)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/cautions` |
| GET | `/api/v1/cautions/:id` |
| POST | `/api/v1/cautions/:id/versements` |
| POST | `/api/v1/cautions/:id/justificatifs` |
| POST | `/api/v1/cautions/:id/retenues` |
| POST | `/api/v1/cautions/:id/restitutions` |
| POST | `/api/v1/cautions/:id/retenues/:transactionId/reponse` |

## Messagerie (§ 54.1)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/messagerie/fils` |
| GET | `/api/v1/messagerie/fils/:id/messages` |
| POST | `/api/v1/messagerie/fils/:id/lu` |
| POST | `/api/v1/messagerie/locataires/:tenantId/messages` |
| POST | `/api/v1/messagerie/locataires/:tenantId/photos` |

## Rapports (§ 26)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/rapports/financier` |
| GET | `/api/v1/rapports/immobilier` |
| GET | `/api/v1/rapports/travaux` |
| GET | `/api/v1/rapports/locataires` |
| GET | `/api/v1/rapports/rentabilite` |

## Paramètres de l’espace

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/parametres` |
| PATCH | `/api/v1/parametres` |
| PATCH | `/api/v1/parametres/profil` |

## Abonnement (§ 31)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/abonnement/plans` |
| GET | `/api/v1/abonnement` |
| GET | `/api/v1/abonnement/paiements` |
| POST | `/api/v1/abonnement/souscrire` |

## Espace locataire (§ 28) — rôle locataire

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/locataire/accueil` |
| GET | `/api/v1/locataire/logement` |
| GET | `/api/v1/locataire/echeances` |
| GET | `/api/v1/locataire/echeances/:id` |
| GET | `/api/v1/locataire/paiements/moyens` |
| GET | `/api/v1/locataire/paiements` |
| GET | `/api/v1/locataire/paiements/transactions` |
| GET | `/api/v1/locataire/paiements/transactions/:id` |
| POST | `/api/v1/locataire/paiements` |
| POST | `/api/v1/locataire/paiements/preuves` |
| GET | `/api/v1/locataire/quittances` |
| GET | `/api/v1/locataire/quittances/:id` |
| GET | `/api/v1/locataire/quittances/:id/pdf` |
| GET | `/api/v1/locataire/caution` |
| POST | `/api/v1/locataire/caution/retenues/:transactionId/contester` |
| GET | `/api/v1/locataire/charges` |
| GET | `/api/v1/locataire/charges/:id` |
| GET | `/api/v1/locataire/incidents` |
| POST | `/api/v1/locataire/incidents` |
| GET | `/api/v1/locataire/incidents/:id` |
| POST | `/api/v1/locataire/incidents/:id/pieces` |
| GET | `/api/v1/locataire/etats-des-lieux` |
| GET | `/api/v1/locataire/etats-des-lieux/:id` |
| GET | `/api/v1/locataire/etats-des-lieux/:id/pdf` |
| POST | `/api/v1/locataire/etats-des-lieux/:id/accepter` |
| POST | `/api/v1/locataire/etats-des-lieux/:id/contester` |
| GET | `/api/v1/locataire/messagerie` |
| GET | `/api/v1/locataire/messagerie/:threadId/messages` |
| POST | `/api/v1/locataire/messagerie/:threadId/messages` |
| POST | `/api/v1/locataire/messagerie/:threadId/photos` |
| POST | `/api/v1/locataire/messagerie/:threadId/lu` |
| POST | `/api/v1/locataire/consentement-whatsapp` |

## Super admin web (§ 29, § 30)

| Méthode | Chemin |
|---|---|
| GET | `/api/v1/admin/dashboard` |
| GET | `/api/v1/admin/proprietaires` |
| GET | `/api/v1/admin/proprietaires/:id` |
| POST | `/api/v1/admin/proprietaires/:id/suspendre` |
| POST | `/api/v1/admin/proprietaires/:id/reactiver` |
| POST | `/api/v1/admin/proprietaires/:ownerId/abonnement/activer` |
| GET | `/api/v1/admin/locataires` |
| GET | `/api/v1/admin/immeubles` |
| GET | `/api/v1/admin/signalements` |
| GET | `/api/v1/admin/signalements/statistiques` |
| GET | `/api/v1/admin/abonnements` |
| GET | `/api/v1/admin/abonnements/:id` |
| POST | `/api/v1/admin/abonnements/:id/suspendre` |
| POST | `/api/v1/admin/abonnements/:id/reactiver` |
| POST | `/api/v1/admin/abonnements/:id/annuler` |
| GET | `/api/v1/admin/paiements` |
| GET | `/api/v1/admin/paiements/loyers/statistiques` |
| GET | `/api/v1/admin/utilisateurs` |
| POST | `/api/v1/admin/utilisateurs` |
| GET | `/api/v1/admin/utilisateurs/:id` |
| POST | `/api/v1/admin/utilisateurs/:id/desactiver` |
| POST | `/api/v1/admin/utilisateurs/:id/activer` |
| POST | `/api/v1/admin/utilisateurs/:id/deverrouiller` |
| GET | `/api/v1/admin/parametres` |
| PUT | `/api/v1/admin/parametres/:cle` |
| POST | `/api/v1/admin/notifications` |
| GET | `/api/v1/admin/notifications` |
| GET | `/api/v1/admin/categories` |
| POST | `/api/v1/admin/categories` |
| PATCH | `/api/v1/admin/categories/:id` |
| POST | `/api/v1/admin/categories/:id/activer` |
| POST | `/api/v1/admin/categories/:id/desactiver` |
| DELETE | `/api/v1/admin/categories/:id` |
| GET | `/api/v1/admin/journal-audit` |
| GET | `/api/v1/admin/roles` |
| GET | `/api/v1/admin/plans` |
| POST | `/api/v1/admin/plans` |
| GET | `/api/v1/admin/plans/:id` |
| PATCH | `/api/v1/admin/plans/:id` |
| POST | `/api/v1/admin/plans/:id/activer` |
| POST | `/api/v1/admin/plans/:id/desactiver` |
| DELETE | `/api/v1/admin/plans/:id` |
| GET | `/api/v1/admin/modeles-bail` |
| GET | `/api/v1/admin/modeles-bail/variables` |
| POST | `/api/v1/admin/modeles-bail` |
| GET | `/api/v1/admin/modeles-bail/:id` |
| PATCH | `/api/v1/admin/modeles-bail/:id` |
| POST | `/api/v1/admin/modeles-bail/:id/publier` |
| POST | `/api/v1/admin/modeles-bail/:id/archiver` |
| GET | `/api/v1/admin/modeles-whatsapp` |
| PATCH | `/api/v1/admin/modeles-whatsapp/:id` |

