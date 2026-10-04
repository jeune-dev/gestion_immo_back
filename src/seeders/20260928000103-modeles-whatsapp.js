'use strict';

/**
 * Modèles WhatsApp des relances et confirmations (§ 54.2).
 *
 * Livrés INACTIFS : un message à l'initiative de l'application doit utiliser
 * un modèle APPROUVÉ par Meta (§ 54.3). Le Super Admin crée chaque modèle dans
 * le compte WhatsApp Business avec le texte ci-dessous, reporte son nom exact
 * dans `meta_template_name` s'il diffère, puis l'active.
 */
const MODELES = [
  ['rappel_avant_echeance', 'rappel_loyer_avant_echeance', 'Rappel : votre loyer {{1}} ({{2}}) arrive à échéance le {{3}}.', ['periode', 'montant', 'date_echeance']],
  ['echeance_jour', 'loyer_exigible_aujourdhui', 'Votre loyer {{1}} ({{2}}) est exigible aujourd’hui.', ['periode', 'montant']],
  ['retard_niveau_1', 'loyer_retard_niveau_1', 'Votre loyer {{1}} n’a pas encore été réglé ({{2}} jours de retard). Reste dû : {{3}}.', ['periode', 'jours_retard', 'reste_du']],
  ['retard_niveau_2', 'loyer_retard_niveau_2', 'Relance : votre loyer {{1}} présente {{2}} jours de retard. Merci de régulariser {{3}} rapidement.', ['periode', 'jours_retard', 'reste_du']],
  ['retard_niveau_3', 'loyer_retard_niveau_3', 'Dernier rappel : votre loyer {{1}} est impayé depuis {{2}} jours. Reste dû : {{3}}. Contactez votre bailleur.', ['periode', 'jours_retard', 'reste_du']],
  ['paiement_confirme', 'paiement_loyer_confirme', 'Paiement de {{1}} reçu pour {{2}}. Référence {{3}}. Votre quittance est disponible dans l’application.', ['montant', 'periode', 'reference']],
  ['incident_mis_a_jour', 'incident_mis_a_jour', 'Votre signalement {{1}} est désormais : {{2}}.', ['reference', 'statut']],
  ['caution_versement', 'caution_versement_confirme', 'Nous confirmons la réception de {{1}} au titre de votre caution (total versé : {{2}}).', ['montant', 'total']],
  ['caution_restitution', 'caution_restituee', 'Restitution de votre caution : {{1}} vous ont été reversés. Montant retenu : {{2}}.', ['montant_restitue', 'montant_retenu']],
];

module.exports = {
  async up(queryInterface) {
    for (const [code, nom, texte, variables] of MODELES) {
      await queryInterface.sequelize.query(
        `INSERT INTO whatsapp_templates (event_code, meta_template_name, language_code, body_preview, variables, is_active)
         VALUES (:code, :nom, 'fr', :texte, ARRAY[:variables]::text[], false)
         ON CONFLICT (event_code) DO NOTHING`,
        { replacements: { code, nom, texte, variables } }
      );
    }
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DELETE FROM whatsapp_templates');
  },
};
