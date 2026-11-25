# Procédure de réponse aux incidents de sécurité

Constat de l'audit de sécurité de novembre 2026 (NIST CSF « Respond / Recover », ISO 27001 A.5.24–A.5.28) : aucune procédure écrite n'existait. Ce document est la référence ; il se garde court pour être suivi sous pression.

## 1. Qui fait quoi

| Rôle | Personne | Joignable |
|---|---|---|
| Responsable incident (décide, coordonne) | _à compléter (KODAFRIK)_ | _téléphone, WhatsApp_ |
| Technique (serveur, base, code) | _à compléter_ | |
| Communication (propriétaires, locataires) | _à compléter_ | |
| Commission des Données Personnelles (CDP) | cdp.sn — notification d'une violation de données | |

## 2. Détecter

Sources d'alerte déjà en place :

- alertes automatiques (`ALERT_WEBHOOK_URL` / `ALERT_EMAIL`) : rafale d'erreurs 5xx, disjoncteur ouvert (paiement, WhatsApp, stockage), verrouillage d'un super administrateur ;
- métriques `/metrics` (`api_erreurs_total`, `rate_limit.depasse.*`) ;
- journal d'audit (table `audit_logs`, non modifiable par le rôle applicatif) : `compte.connexion_echec`, `compte.verrouillage`, `paiement.configuration_moyen`, `compte.suppression`… ;
- signalement d'un utilisateur (support, réseaux sociaux).

## 3. Qualifier (dans l'heure)

| Gravité | Exemples | Délai d'action |
|---|---|---|
| **Critique** | fuite de base, secret exposé (clé `APP_ENC_KEY`, `JWT_SECRET`, clés PayDunya), détournement de loyers, compte super admin compromis | immédiat |
| **Haute** | compte propriétaire compromis, faille exploitable découverte, indisponibilité > 1 h | < 4 h |
| **Moyenne** | tentative de force brute massive, dépendance vulnérable (alerte Dependabot / Trivy) | < 48 h |

Ouvrir une fiche d'incident (date/heure, découvreur, description, gravité, décisions) et la tenir à jour.

## 4. Contenir

| Situation | Action |
|---|---|
| Compte utilisateur compromis | `POST /admin/utilisateurs/:id/reinitialiser-acces` (ferme toutes ses sessions) ; vérifier ses moyens de paiement dans le journal (`paiement.configuration_moyen`) |
| Super admin compromis | depuis un autre super admin : réinitialiser l'accès ; en dernier recours, `UPDATE users SET token_version = token_version + 1, status = 'inactif' WHERE id = …` |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` exposé | générer de nouveaux secrets (`npm run secrets:generer`), redéployer : toutes les sessions tombent |
| `OTP_SECRET` / `INVITATION_SECRET` exposé | remplacer, redéployer : codes et invitations en cours deviennent invalides (à renvoyer) |
| `APP_ENC_KEY` exposée | **critique** : rotation avec rechiffrement (prévoir un script dédié) ; traiter comme une fuite de données |
| Clés PayDunya / Wave / WhatsApp exposées | révoquer dans la console du fournisseur, saisir les nouvelles, redéployer |
| Attaque en cours depuis des IP identifiées | bloquer au pare-feu du VPS (`ufw deny from …`) ou dans nginx |
| Serveur compromis | isoler (couper l'accès public), conserver une image disque pour l'analyse, reconstruire depuis le dépôt et la dernière sauvegarde saine |

## 5. Éradiquer et restaurer

- Corriger la cause (code, configuration), ajouter un test de régression, déployer par la CI.
- Restauration de données : procédure de `docs/EXPLOITATION.md` (sauvegardes chiffrées `age`, test de restauration).
- Vérifier après coup : connexions anormales, moyens de paiement modifiés, exports massifs (`rapport.*`) dans le journal d'audit.

## 6. Notifier

- **Violation de données personnelles** : notifier la CDP sans délai excessif (bonne pratique : 72 h), et les personnes concernées si le risque est élevé (message clair : ce qui s'est passé, données touchées, ce qu'elles doivent faire).
- Prévenir PayDunya / Meta si leurs clés ou API sont en cause.

## 7. Retour d'expérience (sous 2 semaines)

Chronologie, cause racine, ce qui a bien / mal fonctionné, actions préventives avec responsable et échéance. Mettre à jour ce document.
