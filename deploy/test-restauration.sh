#!/usr/bin/env bash
# ============================================================================
#  Test de restauration (constat d'audit M7) — mensuel, voir docs/EXPLOITATION.md.
#
#  1. récupère la DERNIÈRE sauvegarde de la base (copie distante par défaut si
#     BACKUP_RCLONE_REMOTE est défini — c'est elle qui compte en cas de sinistre ;
#     --local pour utiliser BACKUP_DIR) ;
#  2. vérifie son empreinte SHA-256, la déchiffre (clé privée age fournie par
#     l'opérateur : -i <fichier> ou AGE_IDENTITY) ;
#  3. la restaure dans une base TEMPORAIRE <DB_NAME>_verif_<date> sur le même
#     serveur PostgreSQL (la base de production n'est jamais touchée) ;
#  4. contrôles : tables clés non vides, comptages, dernière migration
#     (SequelizeMeta) comparée à la production, archive des fichiers lisible ;
#  5. supprime la base temporaire (y compris en cas d'échec).
#
#  Usage : deploy/test-restauration.sh -i /media/cle/sauvegarde-age.txt [--local]
#  Code de sortie non nul si un contrôle échoue.
# ============================================================================
set -euo pipefail
umask 077
PREFIXE_JOURNAL="[test-restauration]"
# shellcheck source=deploy/_commun.sh
. "$(dirname "$0")/_commun.sh"

IDENTITE="${AGE_IDENTITY:-}"
SOURCE="auto"
while [ $# -gt 0 ]; do
    case "$1" in
        -i) IDENTITE="${2:-}"; shift 2 ;;
        --local) SOURCE="local"; shift ;;
        --distant) SOURCE="distant"; shift ;;
        *) mourir "Usage : $0 -i <cle-privee-age> [--local|--distant]" ;;
    esac
done

charger_configuration
TABLES_CLES=(users owners leases rent_payments audit_logs)
BASE_VERIF="${DB_NAME}_verif_$(date +%Y%m%d_%H%M%S)"
verifier_identifiant "base temporaire" "$BASE_VERIF"
TRAVAIL="$(mktemp -d)"
BASE_CREEE=0
ECHECS=0

a_la_sortie() {
    local code=$?
    if [ "$BASE_CREEE" = "1" ]; then
        journal "Suppression de la base temporaire $BASE_VERIF…"
        pg_cmd psql -d postgres -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS \"$BASE_VERIF\" WITH (FORCE);" \
            || avertir "base temporaire $BASE_VERIF NON supprimée : la supprimer à la main."
    fi
    rm -rf -- "$TRAVAIL"
    [ "$code" -eq 0 ] || printf '%s %s ÉCHEC du test de restauration (code %s)\n' "$PREFIXE_JOURNAL" "$(date -Is)" "$code" >&2
}
trap a_la_sortie EXIT

controle() {  # controle <libellé> <condition vraie ?>
    if [ "$2" = "1" ]; then journal "  [OK]    $1"; else journal "  [ÉCHEC] $1"; ECHECS=$((ECHECS + 1)); fi
}

# ── 1. Dernière sauvegarde ───────────────────────────────────────────────────
if [ "$SOURCE" = "auto" ]; then
    if [ -n "$BACKUP_RCLONE_REMOTE" ]; then SOURCE="distant"; else SOURCE="local"; fi
fi
MOTIF_DB="${DB_NAME}_db_*.dump.age"
MOTIF_UP="${DB_NAME}_uploads_*.tar.age"

dernier_local() { find "$BACKUP_DIR" -maxdepth 1 -type f -name "$1" -printf '%f\n' 2>/dev/null | sort | tail -n 1; }
dernier_distant() { rclone lsf --files-only --include "$1" "$BACKUP_RCLONE_REMOTE" | sort | tail -n 1; }

if [ "$SOURCE" = "distant" ]; then
    [ -n "$BACKUP_RCLONE_REMOTE" ] || mourir "BACKUP_RCLONE_REMOTE absent (utiliser --local)."
    command -v rclone >/dev/null 2>&1 || mourir "rclone introuvable."
    NOM_DB="$(dernier_distant "$MOTIF_DB")"
    NOM_UP="$(dernier_distant "$MOTIF_UP")"
    [ -n "$NOM_DB" ] || mourir "aucune sauvegarde $MOTIF_DB sur $BACKUP_RCLONE_REMOTE."
    journal "Téléchargement de $NOM_DB depuis $BACKUP_RCLONE_REMOTE…"
    for n in "$NOM_DB" "$NOM_UP"; do
        [ -n "$n" ] || continue
        rclone copy "$BACKUP_RCLONE_REMOTE/$n" "$TRAVAIL" -q
        rclone copy "$BACKUP_RCLONE_REMOTE/$n.sha256" "$TRAVAIL" -q || true
    done
    REP="$TRAVAIL"
else
    NOM_DB="$(dernier_local "$MOTIF_DB")"
    NOM_UP="$(dernier_local "$MOTIF_UP")"
    [ -n "$NOM_DB" ] || mourir "aucune sauvegarde $MOTIF_DB dans $BACKUP_DIR."
    REP="$BACKUP_DIR"
fi
journal "Sauvegarde testée : $NOM_DB (source : $SOURCE)"

# Âge de la sauvegarde (RPO 24 h) : horodatage AAAAMMJJ_HHMMSS dans le nom.
HORO="$(sed -E 's/.*_db_([0-9]{8})_([0-9]{6})\.dump\.age$/\1 \2/' <<<"$NOM_DB")"
EPOCH_SAUV="$(date -d "${HORO:0:8} ${HORO:9:2}:${HORO:11:2}:${HORO:13:2}" +%s 2>/dev/null || echo 0)"
AGE_H=$(( ( $(date +%s) - EPOCH_SAUV ) / 3600 ))
controle "sauvegarde de moins de 26 h (âge : ${AGE_H} h)" "$([ "$AGE_H" -le 26 ] && echo 1 || echo 0)"

# ── 2. Empreinte et clé ──────────────────────────────────────────────────────
command -v age >/dev/null 2>&1 || mourir "age introuvable (apt install age)."
[ -n "$IDENTITE" ] && [ -r "$IDENTITE" ] || mourir "clé privée age requise : -i <fichier> (ou AGE_IDENTITY)."
set +e; verifier_empreinte "$REP/$NOM_DB"; etat=$?; set -e
controle "empreinte SHA-256 de $NOM_DB" "$([ "$etat" -eq 0 ] && echo 1 || echo 0)"
[ "$etat" -eq 0 ] || mourir "empreinte absente ou incorrecte : restauration de test interrompue."

# ── 3. Restauration dans une base temporaire ─────────────────────────────────
journal "Création de la base temporaire $BASE_VERIF…"
pg_cmd psql -d postgres -v ON_ERROR_STOP=1 -qc "CREATE DATABASE \"$BASE_VERIF\" TEMPLATE template0;"
BASE_CREEE=1
DEBUT=$(date +%s)
age -d -i "$IDENTITE" "$REP/$NOM_DB" \
    | pg_cmd pg_restore -d "$BASE_VERIF" --no-owner --no-privileges --single-transaction
DUREE=$(( $(date +%s) - DEBUT ))
journal "Restauration réussie en ${DUREE} s (indicateur pour le RTO)."

# ── 4. Contrôles ─────────────────────────────────────────────────────────────
requete() {  # requete <base> <sql> : une valeur, sans en-tête
    pg_cmd psql -d "$1" -v ON_ERROR_STOP=1 -XAtqc "$2"
}
journal "Contrôles :"
for t in "${TABLES_CLES[@]}"; do
    n="$(requete "$BASE_VERIF" "SELECT count(*) FROM public.\"$t\";" 2>/dev/null || echo "ABSENTE")"
    controle "table $t : $n ligne(s)" "$([[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ] && echo 1 || echo 0)"
done
NB_TABLES="$(requete "$BASE_VERIF" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")"
controle "nombre de tables restaurées : $NB_TABLES" "$([ "${NB_TABLES:-0}" -gt 0 ] && echo 1 || echo 0)"
MIGR_VERIF="$(requete "$BASE_VERIF" 'SELECT name FROM "SequelizeMeta" ORDER BY name DESC LIMIT 1;' 2>/dev/null || true)"
MIGR_PROD="$(requete "$DB_NAME" 'SELECT name FROM "SequelizeMeta" ORDER BY name DESC LIMIT 1;' 2>/dev/null || true)"
controle "dernière migration de la sauvegarde : ${MIGR_VERIF:-aucune}" "$([ -n "$MIGR_VERIF" ] && echo 1 || echo 0)"
if [ -n "$MIGR_PROD" ] && [ "$MIGR_PROD" != "$MIGR_VERIF" ]; then
    avertir "dernière migration en production : $MIGR_PROD (différente : migration appliquée après la sauvegarde ?)"
fi

# Archive des fichiers téléversés : déchiffrable et lisible (liste seulement).
if [ -n "${NOM_UP:-}" ] && [ -f "$REP/$NOM_UP" ]; then
    set +e; verifier_empreinte "$REP/$NOM_UP"; etat=$?; set -e
    controle "empreinte SHA-256 de $NOM_UP" "$([ "$etat" -eq 0 ] && echo 1 || echo 0)"
    if NB_FICHIERS="$(age -d -i "$IDENTITE" "$REP/$NOM_UP" | tar -tf - | awk '!/\/$/ { n++ } END { print n + 0 }')"; then
        controle "archive des fichiers lisible : $NB_FICHIERS fichier(s)" 1
    else
        controle "archive des fichiers lisible" 0
    fi
else
    journal "  [--]    pas d'archive de fichiers téléversés (stockage R2 ou aucune sauvegarde)."
fi

# ── 5. Rapport ───────────────────────────────────────────────────────────────
if [ "$ECHECS" -gt 0 ]; then
    mourir "$ECHECS contrôle(s) en échec — sauvegarde $NOM_DB NON validée." 4
fi
journal "RÉSULTAT : sauvegarde $NOM_DB restaurable et cohérente (durée de restauration ${DUREE} s)."
