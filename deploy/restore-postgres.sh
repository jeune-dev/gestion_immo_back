#!/usr/bin/env bash
# ============================================================================
#  Restauration d'une sauvegarde PostgreSQL (procédure : docs/EXPLOITATION.md).
#
#  Usage :
#    deploy/restore-postgres.sh -i /chemin/cle-privee-age.txt backups/<base>_db_<date>.dump.age
#    deploy/restore-postgres.sh backups/<base>_<date>.dump        (ancienne sauvegarde en clair)
#
#  - La clé privée age est APPORTÉE PAR L'OPÉRATEUR (clé USB, tmpfs, fichier
#    d'identité protégé par phrase de passe) : elle n'est jamais stockée sur le
#    serveur. Supprimer toute copie temporaire après usage.
#  - L'empreinte <fichier>.sha256 est vérifiée AVANT toute modification
#    (FORCER_SANS_EMPREINTE=1 pour passer outre, en connaissance de cause).
#  - Le déchiffrement se fait en flux (aucune copie en clair sur disque).
#  - pg_restore --single-transaction : en cas d'erreur (fichier tronqué ou
#    altéré, rejet d'age), tout est annulé et la base reste dans son état initial.
#
#  ATTENTION : remplace le contenu de la base. Arrêter l'API avant :
#    docker compose -f docker-compose.prod.yml stop backend
# ============================================================================
set -euo pipefail
umask 077
PREFIXE_JOURNAL="[restore]"
# shellcheck source=deploy/_commun.sh
. "$(dirname "$0")/_commun.sh"

IDENTITE="${AGE_IDENTITY:-}"
while getopts ":i:" opt; do
    case "$opt" in
        i) IDENTITE="$OPTARG" ;;
        *) mourir "Usage : $0 [-i cle-privee-age] <fichier.dump.age|fichier.dump>" ;;
    esac
done
shift $((OPTIND - 1))
FICHIER="${1:-}"
[ -f "$FICHIER" ] || mourir "Usage : $0 [-i cle-privee-age] <fichier.dump.age|fichier.dump>"

charger_configuration

# ── 1. Empreinte ─────────────────────────────────────────────────────────────
set +e
verifier_empreinte "$FICHIER"; etat=$?
set -e
case "$etat" in
    0) journal "Empreinte SHA-256 vérifiée." ;;
    2) if [ "${FORCER_SANS_EMPREINTE:-0}" = "1" ]; then
           avertir "aucun fichier $FICHIER.sha256 : restauration SANS vérification d'empreinte (forcée)."
       else
           mourir "empreinte absente ($FICHIER.sha256). Récupérer le .sha256 depuis la copie distante, ou FORCER_SANS_EMPREINTE=1."
       fi ;;
    *) mourir "EMPREINTE INCORRECTE : fichier altéré ou incomplet. Restauration refusée." ;;
esac

# ── 2. Déchiffrement (en flux) ───────────────────────────────────────────────
case "$FICHIER" in
    *.age)
        command -v age >/dev/null 2>&1 || mourir "age introuvable (apt install age)."
        [ -n "$IDENTITE" ] || mourir "sauvegarde chiffrée : fournir la clé privée avec -i <fichier> (ou AGE_IDENTITY)."
        [ -r "$IDENTITE" ] || mourir "clé privée illisible : $IDENTITE"
        lire_sauvegarde() { age -d -i "$IDENTITE" "$FICHIER"; } ;;
    *)
        avertir "sauvegarde NON chiffrée (ancien format)."
        lire_sauvegarde() { cat "$FICHIER"; } ;;
esac

# ── 3. Confirmation explicite ────────────────────────────────────────────────
if postgres_en_docker && [ -n "$(docker compose -f "$COMPOSE_FICHIER" ps -q backend 2>/dev/null)" ]; then
    avertir "le conteneur API tourne encore : l'arrêter d'abord est fortement recommandé."
fi
read -r -p "Restaurer $(basename "$FICHIER") dans la base « $DB_NAME » (données actuelles PERDUES) ? Tapez OUI : " ok
[ "$ok" = "OUI" ] || mourir "abandon (confirmation non donnée)."

# ── 4. Restauration transactionnelle ────────────────────────────────────────
journal "Restauration en cours…"
lire_sauvegarde | pg_cmd pg_restore -d "$DB_NAME" --clean --if-exists --no-owner --single-transaction
journal "Restauration terminée. Contrôler : dernière migration, comptages (docs/EXPLOITATION.md), puis redémarrer l'API."
