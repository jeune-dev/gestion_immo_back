#!/usr/bin/env bash
# ============================================================================
#  Fonctions communes aux scripts de sauvegarde / restauration / test.
#  Fichier SOURCÉ (jamais exécuté seul) par :
#    deploy/backup-postgres.sh, deploy/restore-postgres.sh,
#    deploy/test-restauration.sh
#
#  Sécurité : le fichier .env n'est JAMAIS « sourcé » (`. ./.env` exécuterait
#  toute commande qui s'y trouve, ex. `DB_NAME=$(curl … | sh)`). Seules les
#  variables nécessaires sont extraites ligne à ligne, sans évaluation.
# ============================================================================

# Répertoire racine du backend (parent de deploy/).
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FICHIER_ENV="${FICHIER_ENV:-$RACINE/.env}"
COMPOSE_FICHIER="${COMPOSE_FICHIER:-$RACINE/docker-compose.prod.yml}"
PREFIXE_JOURNAL="${PREFIXE_JOURNAL:-[sauvegarde]}"

journal() { printf '%s %s %s\n' "$PREFIXE_JOURNAL" "$(date -Is)" "$*"; }
avertir() { printf '%s %s AVERTISSEMENT : %s\n' "$PREFIXE_JOURNAL" "$(date -Is)" "$*" >&2; }
mourir()  { printf '%s %s ERREUR : %s\n' "$PREFIXE_JOURNAL" "$(date -Is)" "$1" >&2; exit "${2:-1}"; }

# lire_env NOM [DEFAUT]
# Priorité : variable déjà présente dans l'environnement (cron, opérateur),
# puis dernière occurrence `NOM=valeur` dans .env, puis DEFAUT.
# La valeur est prise littéralement : pas d'expansion $(), `…`, ${…}.
# Les guillemets simples ou doubles qui l'entourent sont retirés.
lire_env() {
    local nom="$1" defaut="${2:-}" ligne valeur
    if [ -n "${!nom+x}" ] && [ -n "${!nom}" ]; then
        printf '%s' "${!nom}"
        return 0
    fi
    if [ -r "$FICHIER_ENV" ]; then
        ligne="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${nom}=" "$FICHIER_ENV" | tail -n 1 || true)"
        if [ -n "$ligne" ]; then
            valeur="${ligne#*=}"
            valeur="${valeur%$'\r'}"
            # Commentaire de fin de ligne uniquement pour une valeur non entre guillemets.
            case "$valeur" in
                \"*\"*) valeur="${valeur#\"}"; valeur="${valeur%%\"*}" ;;
                \'*\'*) valeur="${valeur#\'}"; valeur="${valeur%%\'*}" ;;
                *) valeur="${valeur%%[[:space:]]#*}"
                   valeur="${valeur%"${valeur##*[![:space:]]}"}" ;;
            esac
            printf '%s' "$valeur"
            return 0
        fi
    fi
    printf '%s' "$defaut"
}

# Refuse les identifiants qui pourraient injecter du SQL ou des chemins.
verifier_identifiant() {
    local nom="$1" valeur="$2"
    [[ "$valeur" =~ ^[A-Za-z_][A-Za-z0-9_]{0,40}$ ]] \
        || mourir "$nom invalide (« $valeur ») : lettres, chiffres et _ uniquement, 41 caractères max."
}

# Vrai si le conteneur postgres de docker-compose.prod.yml tourne.
postgres_en_docker() {
    command -v docker >/dev/null 2>&1 || return 1
    [ -n "$(docker compose -f "$COMPOSE_FICHIER" ps -q postgres 2>/dev/null)" ]
}

# Commande exécutant un binaire client PostgreSQL (pg_dump, pg_restore, psql)
# dans le conteneur, ou sur l'hôte à défaut. Utilisation :
#   pg_cmd pg_dump -Fc -d base
# Rôle utilisé : BACKUP_DB_USER s'il est défini (rôle propriétaire / de
# maintenance, utile si DB_USER devient un rôle applicatif restreint), sinon
# DB_USER. Hors Docker, le mot de passe vient de ~/.pgpass (recommandé), sinon
# de BACKUP_DB_PASSWORD / DB_PASSWORD, transmis au seul processus enfant.
pg_cmd() {
    local binaire="$1"; shift
    if postgres_en_docker; then
        docker compose -f "$COMPOSE_FICHIER" exec -T postgres "$binaire" -U "$PG_UTILISATEUR" "$@"
    else
        local mdp
        if [ "$PG_UTILISATEUR" = "$DB_USER" ]; then
            mdp="$(lire_env DB_PASSWORD)"
        else
            mdp="$(lire_env BACKUP_DB_PASSWORD)"
        fi
        if [ -n "$mdp" ] && [ ! -r "${PGPASSFILE:-$HOME/.pgpass}" ]; then
            PGPASSWORD="$mdp" "$binaire" -h "$(lire_env DB_HOST 127.0.0.1)" -p "$(lire_env DB_PORT 5432)" -U "$PG_UTILISATEUR" "$@"
        else
            "$binaire" -h "$(lire_env DB_HOST 127.0.0.1)" -p "$(lire_env DB_PORT 5432)" -U "$PG_UTILISATEUR" "$@"
        fi
    fi
}

# verifier_empreinte FICHIER : contrôle FICHIER.sha256 (produit par la sauvegarde).
verifier_empreinte() {
    local fichier="$1" attendu calcule
    [ -f "$fichier.sha256" ] || return 2
    attendu="$(cut -d' ' -f1 < "$fichier.sha256")"
    calcule="$(sha256sum "$fichier" | cut -d' ' -f1)"
    [ -n "$attendu" ] && [ "$attendu" = "$calcule" ]
}

# Charge les variables communes et les valide.
charger_configuration() {
    DB_NAME="$(lire_env DB_NAME)"
    DB_USER="$(lire_env DB_USER)"
    [ -n "$DB_NAME" ] || mourir "DB_NAME absent (environnement ou $FICHIER_ENV)."
    [ -n "$DB_USER" ] || mourir "DB_USER absent (environnement ou $FICHIER_ENV)."
    verifier_identifiant DB_NAME "$DB_NAME"
    verifier_identifiant DB_USER "$DB_USER"
    PG_UTILISATEUR="$(lire_env BACKUP_DB_USER "$DB_USER")"
    verifier_identifiant BACKUP_DB_USER "$PG_UTILISATEUR"
    BACKUP_DIR="$(lire_env BACKUP_DIR "$RACINE/backups")"
    case "$BACKUP_DIR" in /*) ;; *) BACKUP_DIR="$RACINE/${BACKUP_DIR#./}" ;; esac
    BACKUP_RCLONE_REMOTE="$(lire_env BACKUP_RCLONE_REMOTE)"
    export DB_NAME DB_USER PG_UTILISATEUR BACKUP_DIR BACKUP_RCLONE_REMOTE
}
