'use strict';

const { ServiceIndisponibleError } = require('../errors/AppError.js');
const logger = require('./logger.js');
const metrics = require('./metrics.js');

/**
 * Délai et disjoncteur pour les appels aux services externes.
 *
 * Deux défauts, observés sur les appels à Resend (e-mail) et à Firebase
 * (push) :
 *
 *  1. AUCUN DÉLAI. Le SDK Resend appelle `fetch` sans signal d'abandon : un
 *     fournisseur qui accepte la connexion puis ne répond plus retenait la
 *     requête HTTP de l'utilisateur indéfiniment (envoi de rapport, code de
 *     réinitialisation de mot de passe).
 *
 *  2. AUCUNE LIMITE PENDANT UNE PANNE. Fournisseur tombé et 100 utilisateurs
 *     qui envoient un rapport : 100 requêtes accrochées chacune jusqu'au
 *     délai du réseau, qui occupent mémoire et sockets pendant que le reste
 *     de l'API ralentit. Le disjoncteur coupe court : après `seuilEchecs`
 *     échecs consécutifs, les appels suivants échouent IMMÉDIATEMENT
 *     pendant `dureeOuvertureMs`, puis un seul appel d'essai décide de la
 *     reprise.
 *
 * Seules les pannes de la DÉPENDANCE comptent (`estEchecDependance`) : une
 * adresse e-mail refusée est une erreur de la requête, pas une panne du
 * fournisseur — elle ne doit pas couper l'envoi pour tout le monde.
 */

/**
 * Rejette si `promesse` n'est pas réglée dans `delaiMs`.
 *
 * La promesse d'origine n'est pas annulée (le SDK n'expose pas d'abandon) :
 * on cesse seulement de l'attendre. Son éventuel rejet tardif reste géré par
 * `Promise.race`, il ne remonte pas en `unhandledRejection`.
 */
function avecDelai(promesse, delaiMs, libelle) {
  let minuteur;
  const garde = new Promise((_, rejeter) => {
    minuteur = setTimeout(() => {
      rejeter(new ServiceIndisponibleError(
        `Le service ${libelle} ne répond pas. Réessayez dans quelques instants.`,
        'DELAI_DEPASSE',
        { delaiMs },
      ));
    }, delaiMs);
  });
  return Promise.race([promesse, garde]).finally(() => clearTimeout(minuteur));
}

class Disjoncteur {
  /**
   * @param {string} nom — identifiant technique (journaux, métriques)
   * @param {object} [options]
   * @param {number} [options.seuilEchecs=5] — échecs consécutifs avant ouverture
   * @param {number} [options.dureeOuvertureMs=30000] — durée d'ouverture avant un essai
   * @param {number} [options.delaiAppelMs=10000] — délai maximal d'un appel
   * @param {string} [options.libelle] — nom lisible pour l'utilisateur (« d’e-mail »)
   * @param {(err: Error) => boolean} [options.estEchecDependance] — vrai si l'erreur
   *   traduit une panne du service (et non un refus de la requête)
   */
  constructor(nom, {
    seuilEchecs = 5,
    dureeOuvertureMs = 30_000,
    delaiAppelMs = 10_000,
    libelle = nom,
    estEchecDependance = () => true,
  } = {}) {
    this.nom = nom;
    this.seuilEchecs = seuilEchecs;
    this.dureeOuvertureMs = dureeOuvertureMs;
    this.delaiAppelMs = delaiAppelMs;
    this.libelle = libelle;
    this.estEchecDependance = estEchecDependance;
    this.etat = 'ferme';
    this.echecsConsecutifs = 0;
    this.ouvertJusqua = 0;
    this.essaiEnCours = false;
  }

  async executer(fn) {
    if (this.etat === 'ouvert') {
      if (Date.now() < this.ouvertJusqua) return this._refuser();
      this._changerEtat('demi-ouvert');
    }
    // Demi-ouvert : UN seul appel d'essai à la fois. Laisser passer tous
    // ceux qui arrivent reproduirait l'afflux que l'ouverture devait éviter.
    if (this.etat === 'demi-ouvert') {
      if (this.essaiEnCours) return this._refuser();
      this.essaiEnCours = true;
    }

    const debut = Date.now();
    try {
      const resultat = await avecDelai(Promise.resolve().then(fn), this.delaiAppelMs, this.libelle);
      this._succes(Date.now() - debut);
      return resultat;
    } catch (err) {
      const dureeMs = Date.now() - debut;
      if (this.estEchecDependance(err)) {
        this._echec(err, dureeMs);
      } else {
        // Le service a répondu (en refusant la requête) : il est joignable.
        this._succes(dureeMs);
      }
      throw err;
    } finally {
      this.essaiEnCours = false;
    }
  }

  /** Lecture pour les sondes et les tests. */
  etatCourant() {
    return { etat: this.etat, echecsConsecutifs: this.echecsConsecutifs, ouvertJusqua: this.ouvertJusqua || null };
  }

  _refuser() {
    metrics.enregistrerRejetCircuit(this.nom);
    const reessayerDansS = Math.max(1, Math.ceil((this.ouvertJusqua - Date.now()) / 1000));
    throw new ServiceIndisponibleError(
      `Le service ${this.libelle} est momentanément indisponible. Réessayez dans quelques instants.`,
      'SERVICE_EXTERNE_INDISPONIBLE',
      { dependance: this.nom, reessayerDansS },
    );
  }

  _succes(dureeMs) {
    metrics.enregistrerAppelDependance(this.nom, { succes: true, dureeMs });
    this.echecsConsecutifs = 0;
    if (this.etat !== 'ferme') {
      logger.info(`[circuit] ${this.nom} : service rétabli, circuit refermé`);
      this._changerEtat('ferme');
    }
  }

  _echec(err, dureeMs) {
    metrics.enregistrerAppelDependance(this.nom, { succes: false, dureeMs, erreur: err });
    this.echecsConsecutifs += 1;
    if (this.etat === 'demi-ouvert' || this.echecsConsecutifs >= this.seuilEchecs) {
      this.ouvertJusqua = Date.now() + this.dureeOuvertureMs;
      if (this.etat !== 'ouvert') {
        logger.error(
          `[circuit] ${this.nom} : ${this.echecsConsecutifs} échec(s) consécutif(s) — appels suspendus `
          + `${Math.round(this.dureeOuvertureMs / 1000)} s`,
          { dependance: this.nom, error: err.message },
        );
        // Chargé à l'appel (le service d'alertes utilise l'e-mail, lui-même protégé par un disjoncteur).
        const { alerter, TYPES } = require('../infrastructure/alertes.service.js');
        alerter(TYPES.DEPENDANCE_INDISPONIBLE, `Service ${this.nom} indisponible : appels suspendus après ${this.echecsConsecutifs} échec(s)`, { dependance: this.nom });
      }
      this._changerEtat('ouvert');
    }
  }

  _changerEtat(etat) {
    this.etat = etat;
    metrics.enregistrerEtatCircuit(this.nom, etat);
  }
}

module.exports = { Disjoncteur, avecDelai };
