'use strict';

/**
 * État du process, lu par la sonde de disponibilité (`/health/ready`).
 *
 * Pendant l'arrêt propre, le worker finit ses requêtes en cours mais ne doit
 * plus en recevoir : la sonde répond 503 dès que l'arrêt commence, pour que
 * le répartiteur de charge le retire AVANT que le port se ferme — et non
 * après, quand les requêtes échouent déjà en « connexion refusée ».
 */
let arretEnCours = false;

module.exports = {
  estEnArret: () => arretEnCours,
  signalerArret: () => { arretEnCours = true; },
};
