'use strict';

/**
 * Modèles de bail version 1 (§ 53) — habitation, professionnel/commercial, meublé.
 *
 * ⚠️ § 53.5 : ces textes sont une TRAME de travail. Ils sont livrés au statut
 * « brouillon » et NE PEUVENT PAS servir à générer un bail tant que le Super
 * Admin ne les a pas publiés — après relecture et validation par un juriste
 * sénégalais (avocat ou notaire). L'application fournit un modèle, pas un
 * conseil juridique.
 *
 * Variables : {{chemin.variable}} — la liste complète est exposée par
 * GET /api/v1/admin/modeles-bail/variables et contrôlée à la publication.
 */

const COMMUN_DEBUT = `CONTRAT DE BAIL {{bail.type_libelle}}
Référence : {{bail.reference}}

ENTRE LES SOUSSIGNÉS :

{{bailleur.nom}}, joignable au {{bailleur.telephone}}, ci-après dénommé « le Bailleur »,

ET

{{locataire.nom}}, joignable au {{locataire.telephone}}, pièce d'identité : {{locataire.piece_identite}}, ci-après dénommé « le Locataire ».

IL A ÉTÉ CONVENU CE QUI SUIT :

ARTICLE 1 — DÉSIGNATION DU BIEN
Le Bailleur donne en location au Locataire le local suivant : {{bien.type}} n° {{bien.numero}}, étage {{bien.etage}}, de l'immeuble « {{bien.immeuble}} », situé {{bien.adresse}}, {{bien.ville}}. Surface : {{bien.surface}}. Nombre de pièces : {{bien.pieces}}.

ARTICLE 2 — DURÉE ET DATE D'EFFET
Le présent bail prend effet le {{bail.date_debut}} pour {{bail.duree}}.

ARTICLE 3 — LOYER
Le loyer est fixé à {{bail.loyer}} par mois, payable selon une périodicité {{bail.periodicite}}, au plus tard le {{bail.jour_echeance}} de chaque période. Chaque paiement donne lieu à la délivrance d'une quittance.

ARTICLE 4 — CHARGES
En sus du loyer, le Locataire verse une provision sur charges de {{bail.charges}} par mois. {{bail.repartition_charges}}

ARTICLE 5 — CAUTION
Le Locataire verse une caution de {{bail.caution}}. Elle ne porte pas intérêt et est restituée à la fin du bail, déduction faite des sommes dues au Bailleur au titre des loyers, des charges ou des réparations locatives constatées par comparaison des états des lieux d'entrée et de sortie. Toute retenue est motivée et justifiée.

ARTICLE 6 — RÉVISION DU LOYER
{{bail.revision_loyer}}
`;

const COMMUN_FIN = `
ARTICLE 9 — RÉSILIATION ET PRÉAVIS
Chacune des parties peut mettre fin au bail en respectant un préavis de {{bail.preavis_mois}} mois, notifié par écrit. À défaut de paiement du loyer ou des charges, le Bailleur peut engager la résiliation dans les conditions prévues par la loi.

ARTICLE 10 — ANNEXES
{{annexes}}

Fait à {{bien.ville}}, le {{date_generation}}.

Le Bailleur                                   Le Locataire
`;

const HABITATION = `${COMMUN_DEBUT}
ARTICLE 7 — OBLIGATIONS DU BAILLEUR
Le Bailleur délivre un logement décent, en bon état d'usage et de réparation ; il en assure la jouissance paisible au Locataire et effectue les grosses réparations.

ARTICLE 8 — OBLIGATIONS DU LOCATAIRE
Le Locataire paie le loyer et les charges aux termes convenus, use paisiblement des lieux conformément à leur destination d'habitation ({{bail.occupants}} occupant(s) déclaré(s)), répond des dégradations survenues de son fait, effectue l'entretien courant et les menues réparations, et ne peut sous-louer sans accord écrit du Bailleur.
${COMMUN_FIN}`;

const PROFESSIONNEL = `${COMMUN_DEBUT}
ARTICLE 7 — OBLIGATIONS DU BAILLEUR
Le Bailleur délivre un local conforme à l'usage professionnel ou commercial convenu, en assure la jouissance paisible et effectue les grosses réparations.

ARTICLE 8 — OBLIGATIONS DU PRENEUR
Le Preneur exploite les lieux conformément à la destination prévue, paie le loyer et les charges aux termes convenus, entretient les locaux et ne peut céder le bail ou sous-louer sans l'accord du Bailleur, sous réserve des dispositions d'ordre public de l'Acte uniforme OHADA portant sur le droit commercial général relatives au bail à usage professionnel.
${COMMUN_FIN}`;

const MEUBLE = `${COMMUN_DEBUT}
ARTICLE 7 — OBLIGATIONS DU BAILLEUR
Le Bailleur délivre un logement meublé, équipé du mobilier décrit à l'inventaire annexé, en bon état d'usage, et en assure la jouissance paisible.

ARTICLE 8 — OBLIGATIONS DU LOCATAIRE
Le Locataire use paisiblement du logement et du mobilier ({{bail.occupants}} occupant(s) déclaré(s)), répond des dégradations et pertes survenues de son fait, et restitue le mobilier dans l'état constaté à l'inventaire d'entrée, compte tenu de l'usure normale.
${COMMUN_FIN}`;

const NOTE = 'Trame livrée en brouillon : à relire et valider par un juriste sénégalais (avocat ou notaire) avant publication (cahier des charges § 53.5).';

module.exports = {
  async up(queryInterface) {
    const modeles = [
      ['habitation', "Bail d'habitation", HABITATION],
      ['professionnel', 'Bail professionnel / commercial', PROFESSIONNEL],
      ['meuble', 'Bail meublé', MEUBLE],
    ];
    for (const [type, titre, corps] of modeles) {
      await queryInterface.sequelize.query(
        `INSERT INTO lease_templates (lease_type, version, title, body, status, legal_notes)
         VALUES (:type, 1, :titre, :corps, 'brouillon', :note)
         ON CONFLICT (lease_type, version) DO NOTHING`,
        { replacements: { type, titre, corps, note: NOTE } }
      );
    }
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DELETE FROM lease_templates lt WHERE version = 1 AND NOT EXISTS (SELECT 1 FROM lease_documents d WHERE d.template_id = lt.id)');
  },
};
