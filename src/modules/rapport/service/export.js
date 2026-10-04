'use strict';

const { versCsv } = require('./csv.js');
const {
  CATEGORIE_TRAVAUX: LIBELLES_CATEGORIE_TRAVAUX, METIER_ARTISAN: LIBELLES_METIER, GROUPE_CAISSE_SORTIE: LIBELLES_GROUPE,
} = require('../../../config/enums.js');

/**
 * Mise en forme CSV des rapports (§ 26) : mêmes chiffres que le JSON, en
 * sections lisibles dans un tableur (synthèse clé / valeur, puis tableaux).
 * Aucune requête ici : on ne fait que projeter l'objet du rapport.
 */

const MONTANT = 'Montant (FCFA)';

/** Section d'identification : rapport, période, immeuble filtré. */
function enTete(titre, r) {
  return {
    titre,
    entetes: ['Du', 'Au', 'Immeuble'],
    lignes: [[r.periode.du, r.periode.au, r.building ? r.building.name : 'Tous les immeubles']],
  };
}

const nomLocataire = (l) => `${l.first_name} ${l.last_name}`;

function financier(r) {
  return versCsv([
    enTete('Rapport financier', r),
    {
      titre: 'Synthèse',
      entetes: ['Rubrique', MONTANT],
      lignes: [
        ['Loyers encaissés', r.revenus.loyers],
        ['Charges récupérées', r.revenus.charges_recuperees],
        ['Autres revenus', r.revenus.autres_revenus],
        ['Total des revenus (hors caution)', r.revenus.total],
        ['Total des dépenses', r.depenses.total],
        ['Bénéfice net', r.benefice_net],
        [`Impayés au ${r.impayes.date}`, r.impayes.montant],
        ['Factures communes', r.charges.factures_total],
        ['Charges refacturées aux locataires', r.charges.refacturees_locataires],
        ['Charges récupérées auprès des locataires', r.charges.recuperees_locataires],
        ['Charges restant à recouvrer', r.charges.reste_a_recouvrer],
        ['Charges à la charge du propriétaire', r.charges.a_charge_proprietaire],
      ],
    },
    {
      titre: 'Dépenses par catégorie',
      entetes: ['Catégorie', 'Groupe', 'Nombre', MONTANT],
      lignes: r.depenses.par_categorie.map((c) => [c.name, LIBELLES_GROUPE[c.cash_group] || c.cash_group, c.nombre, c.total]),
    },
    {
      titre: 'Par immeuble',
      entetes: ['Immeuble', 'Loyers', 'Charges récupérées', 'Autres revenus', 'Revenus', 'Dépenses', 'Bénéfice net', 'Impayés'],
      lignes: r.par_immeuble.map((b) => [
        b.name, b.revenus.loyers, b.revenus.charges_recuperees, b.revenus.autres_revenus, b.revenus.total,
        b.depenses, b.benefice_net, b.impayes,
      ]),
    },
  ]);
}

function immobilier(r) {
  const colonnes = (l) => [
    l.appartements, l.occupes, l.disponibles, l.en_travaux, l.indisponibles,
    l.taux_occupation, l.taux_vacance, l.taux_occupation_periode,
    l.loyers.loyer_mensuel_occupes, l.loyers.loyer_moyen, l.loyers.loyer_potentiel, l.loyers.manque_a_gagner_vacance,
  ];
  return versCsv([
    enTete('Rapport immobilier', r),
    {
      titre: 'Occupation et loyers',
      entetes: [
        'Immeuble', 'Appartements', 'Occupés', 'Disponibles', 'En travaux', 'Indisponibles',
        'Taux d’occupation (%)', 'Taux de vacance (%)', 'Occupation sur la période (%)',
        'Loyer mensuel des occupés', 'Loyer moyen', 'Loyer potentiel', 'Manque à gagner (vacance)',
      ],
      lignes: [
        ...r.par_immeuble.map((b) => [b.name, ...colonnes(b)]),
        ['Total', ...colonnes(r)],
      ],
    },
  ]);
}

function travaux(r) {
  const artisan = (a) => [a.name, LIBELLES_METIER[a.trade] || a.trade, a.nombre, a.termines, a.cout_reel, a.montant_paye];
  return versCsv([
    enTete('Rapport travaux', r),
    {
      titre: 'Synthèse',
      entetes: ['Rubrique', 'Valeur'],
      lignes: [
        ['Travaux créés sur la période', r.crees_sur_periode],
        ['dont terminés', r.termines],
        ['dont en cours', r.en_cours],
        ['dont en attente de validation', r.en_attente],
        ['dont annulés', r.annules],
        ['Travaux terminés sur la période', r.termines_sur_periode],
        ['Travaux en cours actuellement', r.en_cours_actuellement],
        ['Coût estimé (FCFA)', r.couts.estime],
        ['Coût réel (FCFA)', r.couts.reel],
        ['Dépenses liées (FCFA)', r.couts.depenses_liees],
        ['Dépenses de travaux de la période (FCFA)', r.depenses_travaux_periode],
      ],
    },
    {
      titre: 'Par catégorie',
      entetes: ['Catégorie', 'Nombre', 'Terminés', 'En cours', 'En attente', 'Annulés', 'Coût estimé', 'Coût réel', 'Dépenses liées'],
      lignes: r.par_categorie.map((c) => [
        LIBELLES_CATEGORIE_TRAVAUX[c.category] || c.category, c.nombre, c.termines, c.en_cours, c.en_attente, c.annules,
        c.cout_estime, c.cout_reel, c.depenses_liees,
      ]),
    },
    {
      titre: 'Artisans (par montant payé)',
      entetes: ['Artisan', 'Métier', 'Travaux confiés', 'Terminés', 'Coût réel', 'Montant payé'],
      lignes: r.artisans.par_montant.map(artisan),
    },
    {
      titre: 'Artisans (par nombre de travaux)',
      entetes: ['Artisan', 'Métier', 'Travaux confiés', 'Terminés', 'Coût réel', 'Montant payé'],
      lignes: r.artisans.par_nombre.map(artisan),
    },
  ]);
}

function locataires(r) {
  const bail = (b) => [b.date, nomLocataire(b), b.phone, b.building_name, b.apartment_number, b.reference, b.rent_amount];
  return versCsv([
    enTete('Rapport locataires', r),
    {
      titre: 'Synthèse',
      entetes: ['Rubrique', 'Valeur'],
      lignes: [
        ['Locataires actifs', r.actifs],
        ['Locataires ayant occupé sur la période', r.actifs_sur_periode],
        ['Arrivées', r.arrivees.nombre],
        ['Départs', r.departs.nombre],
        [`Impayés au ${r.impayes.date} (FCFA)`, r.impayes.total],
      ],
    },
    {
      titre: 'Arrivées',
      entetes: ['Date', 'Locataire', 'Téléphone', 'Immeuble', 'Appartement', 'Bail', 'Loyer'],
      lignes: r.arrivees.baux.map(bail),
    },
    {
      titre: 'Départs',
      entetes: ['Date', 'Locataire', 'Téléphone', 'Immeuble', 'Appartement', 'Bail', 'Loyer', 'Motif'],
      lignes: r.departs.baux.map((b) => [...bail(b), b.motif]),
    },
    {
      titre: 'Impayés par locataire',
      entetes: ['Locataire', 'Téléphone', 'Appartements', 'Échéances', 'Plus ancienne échéance', MONTANT],
      lignes: r.impayes.locataires.map((l) => [
        nomLocataire(l), l.phone, l.apartments, l.echeances, l.plus_ancienne_echeance, l.montant,
      ]),
    },
  ]);
}

function rentabilite(r) {
  return versCsv([
    enTete('Rentabilité par appartement', r.entete),
    {
      titre: 'Classement par résultat net',
      entetes: [
        'Rang', 'Immeuble', 'Appartement', 'Loyers', 'Charges récupérées', 'Autres revenus', 'Revenus',
        'Dépenses', 'Résultat net', 'Jours d’occupation', 'Taux d’occupation (%)',
      ],
      lignes: r.rows.map((l) => [
        l.rang, l.building_name, l.apartment_number, l.loyers, l.charges_recuperees, l.autres_revenus, l.revenus,
        l.depenses, l.resultat_net, l.jours_occupation, l.taux_occupation,
      ]),
    },
  ]);
}

module.exports = {
  financier, immobilier, travaux, locataires, rentabilite,
};
