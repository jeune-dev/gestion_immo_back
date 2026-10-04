'use strict';

/**
 * Énumérations métier — SOURCE UNIQUE.
 *
 * Utilisées par les modèles, les schémas Joi, les CHECK SQL de la migration
 * initiale et la route publique `/referentiels` lue par le mobile et le web.
 * Un test (`enums.coherence.test.js`) vérifie que chaque CHECK en base accepte
 * exactement ces valeurs : toute évolution passe par une nouvelle migration.
 *
 * Les libellés affichables sont fournis à côté des codes (clients sans
 * traduction à maintenir).
 */

const def = (entrees) => Object.freeze(Object.fromEntries(entrees));

const ROLES = def([
  ['super_admin', 'Super administrateur'],
  ['proprietaire', 'Propriétaire'],
  ['locataire', 'Locataire'],
]);

const STATUT_UTILISATEUR = def([
  ['actif', 'Actif'],
  ['inactif', 'Inactif'],
]);

const STATUT_PROPRIETAIRE = def([
  ['actif', 'Actif'],
  ['suspendu', 'Suspendu'],
]);

const STATUT_APPARTEMENT = def([
  ['disponible', 'Disponible'],
  ['occupe', 'Occupé'],
  ['en_travaux', 'En travaux'],
  ['indisponible', 'Indisponible'],
]);

const TYPE_APPARTEMENT = def([
  ['studio', 'Studio'],
  ['chambre', 'Chambre'],
  ['f1', 'F1'],
  ['f2', 'F2'],
  ['f3', 'F3'],
  ['f4', 'F4'],
  ['f5', 'F5 et plus'],
  ['duplex', 'Duplex'],
  ['villa', 'Villa'],
  ['local_commercial', 'Local commercial'],
  ['bureau', 'Bureau'],
  ['magasin', 'Magasin'],
  ['autre', 'Autre'],
]);

const TYPE_PIECE_IDENTITE = def([
  ['cni', "Carte nationale d'identité"],
  ['passeport', 'Passeport'],
  ['carte_sejour', 'Carte de séjour'],
  ['permis', 'Permis de conduire'],
  ['autre', 'Autre'],
]);

const TYPE_BAIL = def([
  ['habitation', "Bail d'habitation"],
  ['professionnel', 'Bail professionnel / commercial'],
  ['meuble', 'Bail meublé'],
]);

const PERIODICITE = def([
  ['mensuel', 'Mensuelle'],
  ['bimestriel', 'Bimestrielle'],
  ['trimestriel', 'Trimestrielle'],
  ['semestriel', 'Semestrielle'],
  ['annuel', 'Annuelle'],
]);

/** Nombre de mois couverts par une échéance, selon la périodicité. */
const MOIS_PAR_PERIODICITE = Object.freeze({
  mensuel: 1, bimestriel: 2, trimestriel: 3, semestriel: 6, annuel: 12,
});

const STATUT_BAIL = def([
  ['brouillon', 'Brouillon'],
  ['actif', 'Actif'],
  ['termine', 'Terminé'],
  ['clos', 'Clos'],
  ['annule', 'Annulé'],
]);

const STATUT_ECHEANCE = def([
  ['a_venir', 'À venir'],
  ['a_payer', 'À payer'],
  ['partiellement_paye', 'Partiellement payé'],
  ['paye', 'Payé'],
  ['en_retard', 'En retard'],
  ['annule', 'Annulé'],
]);

const TYPE_CHARGE = def([
  ['eau', 'Eau'],
  ['electricite', 'Électricité'],
  ['nettoyage', 'Nettoyage'],
  ['securite', 'Sécurité'],
  ['ascenseur', 'Ascenseur'],
  ['entretien', 'Entretien'],
  ['internet', 'Internet'],
  ['gardiennage', 'Gardiennage'],
  ['autre', 'Autres'],
]);

const METHODE_REPARTITION = def([
  ['egale', 'Répartition égale'],
  ['consommation', 'Selon consommation'],
  ['coefficient', 'Selon coefficient'],
  ['occupants', "Selon nombre d'occupants"],
  ['personnalise', 'Montant personnalisé'],
]);

const STATUT_FACTURE_COMMUNE = def([
  ['brouillon', 'À répartir'],
  ['repartie', 'Répartie'],
  ['annulee', 'Annulée'],
]);

const STATUT_CHARGE = def([
  ['a_payer', 'À payer'],
  ['partiellement_paye', 'Partiellement payé'],
  ['paye', 'Payé'],
  ['en_retard', 'En retard'],
  ['annule', 'Annulé'],
]);

const MODE_PAIEMENT = def([
  ['especes', 'Espèces'],
  ['wave', 'Wave'],
  ['orange_money', 'Orange Money'],
  ['virement', 'Virement'],
  ['cheque', 'Chèque'],
  ['carte', 'Carte bancaire'],
  ['autre', 'Autre'],
]);

/** Fournisseurs de paiement numérique (§ 51). */
const FOURNISSEUR_PAIEMENT = def([
  ['paydunya', 'PayDunya (Wave, Orange Money)'],
  ['wave', 'Wave'],
  ['orange_money', 'Orange Money'],
]);

/** Portefeuille choisi par le locataire au moment de payer. */
const PORTEFEUILLE = def([
  ['wave', 'Wave'],
  ['orange_money', 'Orange Money'],
]);

const MODE_TRANSACTION = def([
  ['integre', 'Paiement intégré'],
  ['preuve', 'Paiement direct avec preuve'],
]);

const STATUT_TRANSACTION = def([
  ['initiee', 'Initiée'],
  ['en_attente', 'En attente'],
  ['confirmee', 'Confirmée'],
  ['a_rapprocher', 'À rapprocher'],
  ['echouee', 'Échouée'],
  ['annulee', 'Annulée'],
  ['remboursee', 'Remboursée'],
]);

const STATUT_PAIEMENT = def([
  ['valide', 'Valide'],
  ['rembourse', 'Remboursé'],
]);

const TYPE_RAPPROCHEMENT = def([
  ['non_identifie', 'Paiement non identifié'],
  ['excedent', 'Excédent de paiement'],
]);

const STATUT_RAPPROCHEMENT = def([
  ['en_attente', 'À traiter'],
  ['resolu', 'Résolu'],
  ['rejete', 'Rejeté'],
]);

/** Regroupement des sorties de caisse (§ 21). */
const GROUPE_CAISSE_SORTIE = def([
  ['travaux', 'Travaux'],
  ['entretien', 'Entretien'],
  ['factures', 'Factures'],
  ['nettoyage', 'Nettoyage'],
  ['securite', 'Sécurité'],
  ['autre', 'Autres dépenses'],
]);

/** Catégories de mouvements de caisse (§ 21, § 55.4). */
const CATEGORIE_CAISSE = def([
  ['loyer', 'Loyers'],
  ['charges', 'Charges'],
  ['autre_revenu', 'Autres revenus'],
  ['caution', 'Caution'],
  ['travaux', 'Travaux'],
  ['entretien', 'Entretien'],
  ['factures', 'Factures'],
  ['nettoyage', 'Nettoyage'],
  ['securite', 'Sécurité'],
  ['autre_depense', 'Autres dépenses'],
  ['remboursement', 'Remboursement'],
]);

const SENS_CAISSE = def([
  ['entree', 'Entrée'],
  ['sortie', 'Sortie'],
]);

const STATUT_DEPENSE = def([
  ['valide', 'Valide'],
  ['annulee', 'Annulée'],
]);

const METIER_ARTISAN = def([
  ['plombier', 'Plombier'],
  ['electricien', 'Électricien'],
  ['macon', 'Maçon'],
  ['peintre', 'Peintre'],
  ['climatisation', 'Climatisation'],
  ['serrurier', 'Serrurier'],
  ['menuisier', 'Menuisier'],
  ['autre', 'Autre'],
]);

const CATEGORIE_TRAVAUX = def([
  ['plomberie', 'Plomberie'],
  ['electricite', 'Électricité'],
  ['maconnerie', 'Maçonnerie'],
  ['peinture', 'Peinture'],
  ['climatisation', 'Climatisation'],
  ['serrurerie', 'Serrurerie'],
  ['menuiserie', 'Menuiserie'],
  ['nettoyage', 'Nettoyage'],
  ['autre', 'Autre'],
]);

const PRIORITE = def([
  ['basse', 'Basse'],
  ['normale', 'Normale'],
  ['haute', 'Haute'],
  ['urgente', 'Urgente'],
]);

const STATUT_TRAVAUX = def([
  ['signale', 'Signalé'],
  ['a_valider', 'À valider'],
  ['valide', 'Validé'],
  ['artisan_assigne', 'Artisan assigné'],
  ['en_cours', 'En cours'],
  ['termine', 'Terminé'],
  ['annule', 'Annulé'],
]);

const PHASE_PHOTO = def([
  ['avant', 'Avant'],
  ['pendant', 'Pendant'],
  ['apres', 'Après'],
]);

const CATEGORIE_INCIDENT = def([
  ['fuite', 'Fuite'],
  ['panne_electrique', 'Panne électrique'],
  ['climatisation', 'Climatisation'],
  ['serrure', 'Serrure'],
  ['porte', 'Porte'],
  ['plomberie', 'Plomberie'],
  ['probleme_commun', 'Problème commun'],
  ['autre', 'Autre'],
]);

const STATUT_INCIDENT = def([
  ['signale', 'Signalé'],
  ['en_analyse', 'En analyse'],
  ['travaux_planifies', 'Travaux planifiés'],
  ['resolu', 'Résolu'],
  ['rejete', 'Rejeté'],
]);

const TYPE_ETAT_DES_LIEUX = def([
  ['entree', 'Entrée'],
  ['sortie', 'Sortie'],
]);

const STATUT_ETAT_DES_LIEUX = def([
  ['brouillon', 'Brouillon'],
  ['soumis', 'Soumis au locataire'],
  ['accepte', 'Accepté'],
  ['conteste', 'Contesté'],
  ['remplace', 'Remplacé par une nouvelle version'],
]);

const ELEMENT_ETAT_DES_LIEUX = def([
  ['murs', 'Murs'],
  ['sols', 'Sols'],
  ['plafond', 'Plafond'],
  ['portes', 'Portes'],
  ['fenetres', 'Fenêtres'],
  ['electricite', 'Électricité'],
  ['plomberie', 'Plomberie'],
  ['sanitaires', 'Sanitaires'],
  ['mobilier', 'Mobilier'],
  ['autre', 'Autre'],
]);

const ETAT_ELEMENT = def([
  ['bon', 'Bon'],
  ['usage', 'Usagé'],
  ['degrade', 'Dégradé'],
  ['hors_service', 'Hors service'],
]);

/** Ordre de gravité — sert à la comparaison entrée / sortie (§ 52.3 étape 5). */
const GRAVITE_ETAT = Object.freeze({ bon: 0, usage: 1, degrade: 2, hors_service: 3 });

const STATUT_CAUTION = def([
  ['attendue', 'Attendue'],
  ['partiellement_versee', 'Partiellement versée'],
  ['detenue', 'Détenue'],
  ['restitution_en_cours', 'Restitution en cours'],
  ['retenue_partielle', 'Retenue partielle'],
  ['restituee', 'Restituée'],
  ['litige', 'Litige'],
]);

const TYPE_MOUVEMENT_CAUTION = def([
  ['versement', 'Versement'],
  ['retenue', 'Retenue'],
  ['restitution', 'Restitution'],
]);

const MOTIF_RETENUE = def([
  ['degradation', 'Dégradation'],
  ['loyer_impaye', 'Loyer impayé'],
  ['charges', 'Charges impayées'],
  ['autre', 'Autre'],
]);

const STATUT_CONTESTATION = def([
  ['conteste', 'Contestée'],
  ['maintenue', 'Retenue maintenue'],
  ['annulee', 'Retenue annulée'],
  ['ajustee', 'Retenue ajustée'],
]);

const CANAL = def([
  ['in_app', 'Notification interne'],
  ['push', 'Notification push'],
  ['whatsapp', 'WhatsApp'],
  ['sms', 'SMS'],
  ['email', 'E-mail'],
]);

const STATUT_ENVOI = def([
  ['en_attente', 'En attente'],
  ['envoye', 'Envoyé'],
  ['distribue', 'Distribué'],
  ['lu', 'Lu'],
  ['echec', 'Échec'],
  ['ignore', 'Ignoré'],
]);

const TYPE_NOTIFICATION = def([
  ['nouveau_paiement', 'Nouveau paiement'],
  ['retard_loyer', 'Retard de loyer'],
  ['facture', 'Facture'],
  ['incident', 'Incident'],
  ['nouveau_travail', 'Nouveau travail'],
  ['travail_termine', 'Travail terminé'],
  ['depense', 'Dépense'],
  ['echeance', 'Échéance'],
  ['document_disponible', 'Document disponible'],
  ['nouveau_message', 'Nouveau message'],
  ['caution', 'Caution'],
  ['etat_des_lieux', 'État des lieux'],
  ['rapprochement', 'Paiement à rapprocher'],
  ['abonnement', 'Abonnement'],
  ['systeme', 'Information'],
]);

const STATUT_ABONNEMENT = def([
  ['essai', "Période d'essai"],
  ['actif', 'Actif'],
  ['expire', 'Expiré'],
  ['suspendu', 'Suspendu'],
  ['annule', 'Annulé'],
]);

const PERIODE_FACTURATION = def([
  ['mensuel', 'Mensuelle'],
  ['annuel', 'Annuelle'],
]);

const STATUT_PLAN = def([
  ['actif', 'Actif'],
  ['inactif', 'Inactif'],
]);

const STATUT_PAIEMENT_ABONNEMENT = def([
  ['initie', 'Initié'],
  ['confirme', 'Confirmé'],
  ['echoue', 'Échoué'],
  ['annule', 'Annulé'],
]);

/** Fonctionnalités activables par plan (§ 31). */
const FONCTIONNALITE = def([
  ['paiement_integre', 'Paiement Wave / Orange Money intégré'],
  ['relances_whatsapp', 'Relances WhatsApp'],
  ['rapports', 'Rapports'],
  ['modeles_bail', 'Génération de bail'],
  ['etats_des_lieux', 'États des lieux'],
  ['messagerie', 'Messagerie'],
]);

const STATUT_MODELE_BAIL = def([
  ['brouillon', 'Brouillon'],
  ['publie', 'Publié'],
  ['archive', 'Archivé'],
]);

const CATEGORIE_DOCUMENT = def([
  ['photo', 'Photo'],
  ['contrat', 'Contrat'],
  ['justificatif', 'Justificatif'],
  ['piece_identite', "Pièce d'identité"],
  ['quittance', 'Quittance'],
  ['etat_des_lieux', 'État des lieux'],
  ['facture', 'Facture'],
  ['preuve_paiement', 'Preuve de paiement'],
  ['recu', 'Reçu'],
  ['video', 'Vidéo'],
  ['autre', 'Autre'],
]);

/** Ressources auxquelles un document peut être rattaché. */
const ENTITE_DOCUMENT = def([
  ['building', 'Immeuble'],
  ['apartment', 'Appartement'],
  ['tenant', 'Locataire'],
  ['lease', 'Bail'],
  ['work_order', 'Travaux'],
  ['incident', 'Incident'],
  ['inspection', 'État des lieux'],
  ['expense', 'Dépense'],
  ['deposit', 'Caution'],
  ['message', 'Message'],
  ['charge_invoice', 'Facture commune'],
  ['payment_transaction', 'Transaction'],
  ['receipt', 'Quittance'],
  ['contractor', 'Artisan'],
]);

const POLITIQUE_EDL_ENTREE = def([
  ['bloquant', 'Bloquant'],
  ['avertissement', 'Avertissement'],
  ['desactive', 'Désactivé'],
]);

const STRATEGIE_ENVOI = def([
  ['repli', 'Premier canal qui aboutit'],
  ['tous', 'Tous les canaux'],
]);

const PLATEFORME_APPAREIL = def([
  ['android', 'Android'],
  ['ios', 'iOS'],
  ['web', 'Web'],
]);

/** Codes seuls, pour les CHECK SQL et Joi. */
const codes = (enumeration) => Object.keys(enumeration);

module.exports = {
  ROLES, STATUT_UTILISATEUR, STATUT_PROPRIETAIRE,
  STATUT_APPARTEMENT, TYPE_APPARTEMENT, TYPE_PIECE_IDENTITE,
  TYPE_BAIL, PERIODICITE, MOIS_PAR_PERIODICITE, STATUT_BAIL, STATUT_ECHEANCE,
  TYPE_CHARGE, METHODE_REPARTITION, STATUT_FACTURE_COMMUNE, STATUT_CHARGE,
  MODE_PAIEMENT, FOURNISSEUR_PAIEMENT, PORTEFEUILLE, MODE_TRANSACTION, STATUT_TRANSACTION, STATUT_PAIEMENT,
  TYPE_RAPPROCHEMENT, STATUT_RAPPROCHEMENT,
  GROUPE_CAISSE_SORTIE, CATEGORIE_CAISSE, SENS_CAISSE, STATUT_DEPENSE,
  METIER_ARTISAN, CATEGORIE_TRAVAUX, PRIORITE, STATUT_TRAVAUX, PHASE_PHOTO,
  CATEGORIE_INCIDENT, STATUT_INCIDENT,
  TYPE_ETAT_DES_LIEUX, STATUT_ETAT_DES_LIEUX, ELEMENT_ETAT_DES_LIEUX, ETAT_ELEMENT, GRAVITE_ETAT,
  STATUT_CAUTION, TYPE_MOUVEMENT_CAUTION, MOTIF_RETENUE, STATUT_CONTESTATION,
  CANAL, STATUT_ENVOI, TYPE_NOTIFICATION,
  STATUT_ABONNEMENT, PERIODE_FACTURATION, STATUT_PLAN, STATUT_PAIEMENT_ABONNEMENT, FONCTIONNALITE,
  STATUT_MODELE_BAIL, CATEGORIE_DOCUMENT, ENTITE_DOCUMENT,
  POLITIQUE_EDL_ENTREE, STRATEGIE_ENVOI, PLATEFORME_APPAREIL,
  codes,
};
