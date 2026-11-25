# Durées de conservation des données personnelles

Constat M4 de l'audit de sécurité (novembre 2026) — loi sénégalaise 2008-12 (principe de limitation de la conservation), RGPD par analogie.

| Donnée | Durée | Mise en œuvre |
|---|---|---|
| Compte utilisateur supprimé à sa demande | anonymisation **immédiate** (nom, e-mail, téléphone, mot de passe, double authentification, sessions, appareils) | `POST /api/v1/compte/suppression` (mot de passe + code 2FA si active, confirmation « SUPPRIMER ») |
| Espace propriétaire d'un compte supprimé | suspendu ; conservé avec ses pièces comptables | refus tant qu'un bail est actif (`409 BAUX_ACTIFS`) |
| Pièces comptables (loyers, paiements, quittances, caisse, cautions, dépenses) | **10 ans** (obligation comptable, Acte uniforme OHADA) | aucune suppression automatique avant ce terme |
| Journal d'audit | 10 ans (rattaché aux pièces comptables) | table non modifiable par le rôle applicatif |
| Pièce d'identité du locataire (numéro chiffré + fichiers « Pièce d'identité ») | **12 mois après la fin du dernier bail** chez ce bailleur (ou 12 mois après la création de la fiche sans bail) | tâche `retention` (chaque nuit, 03:45) → `locataire.purge_piece_identite` dans le journal |
| Codes de vérification du téléphone et de réinitialisation | 24 h | tâche `nettoyage` |
| Invitations locataire | 90 jours après usage ou expiration | tâche `nettoyage` |
| Sessions (refresh tokens) | 30 jours après expiration ou révocation | tâche `nettoyage` |
| Notifications lues | 12 mois | tâche `nettoyage` |

Un locataire qui supprime son compte ne supprime pas la fiche que tient son bailleur (le bail et les quittances appartiennent à la comptabilité du bailleur) : la fiche est détachée du compte et suit les durées ci-dessus.

À faire hors code : déclaration à la CDP, registre des traitements, mention de ces durées dans la politique de confidentialité du site.
