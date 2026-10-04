#!/usr/bin/env bash
# ============================================================================
#  Sauvegarde quotidienne chiffrée + copie hors site (§ 32 « Sauvegardes »,
#  constat d'audit M7). Procédure complète : docs/EXPLOITATION.md.
#
#  Cron (voir docs/EXPLOITATION.md) :
#    15 2 * * * /opt/gestion-imo/back/deploy/backup-postgres.sh >> /var/log/gestion-imo/backup.log 2>&1
#
#  Produit, dans BACKUP_DIR (défaut : ./backups) :
#    <DB_NAME>_db_<horodatage>.dump.age        pg_dump -Fc chiffré (age)
#    <DB_NAME>_uploads_<horodatage>.tar.age    fichiers téléversés chiffrés
#    <fichier>.sha256                          empreinte SHA-256 de chaque fichier
#  puis les copie vers BACKUP_RCLONE_REMOTE (rclone) et vérifie la copie.
#
#  Variables (environnement, sinon .env — lu SANS être exécuté) :
#    DB_NAME, DB_USER, [DB_HOST, DB_PORT, DB_PASSWORD ou ~/.pgpass hors Docker]
#    BACKUP_AGE_RECIPIENT   clé(s) publique(s) age « age1… » (séparées par des
#                           virgules ou des espaces) OU chemin absolu d'un fichier
#                           de destinataires. La clé PRIVÉE n'est jamais sur le serveur.
#    BACKUP_RCLONE_REMOTE   destination hors site, ex. « r2-sauvegardes:gestion-imo-backups/prod »
#    BACKUP_DIR             défaut ./backups
#    RETENTION_JOURS        rétention LOCALE (défaut 14) ; la rétention distante
#                           relève de la règle de cycle de vie du bucket.
#    BACKUP_ALLOW_PLAINTEXT=1        (développement SEULEMENT) dump en clair autorisé
#    BACKUP_ALLOW_LOCAL_ONLY=1       (développement SEULEMENT) pas de copie hors site
#    BACKUP_RCLONE_CHECK_DOWNLOAD=1  vérification par relecture complète de la copie
#
#  Codes de sortie : 0 OK ; 1 erreur ; 3 copie hors site absente ou en échec
#  (la sauvegarde locale existe alors, mais l'alerte doit être traitée).
# ============================================================================
set -euo pipefail
umask 077
PREFIXE_JOURNAL="[backup]"
# shellcheck source=deploy/_commun.sh
. "$(dirname "$0")/_commun.sh"

charger_configuration
RETENTION_JOURS="$(lire_env RETENTION_JOURS 14)"
[[ "$RETENTION_JOURS" =~ ^[0-9]+$ ]] || mourir "RETENTION_JOURS doit être un entier."
BACKUP_AGE_RECIPIENT="$(lire_env BACKUP_AGE_RECIPIENT)"
BACKUP_ALLOW_PLAINTEXT="$(lire_env BACKUP_ALLOW_PLAINTEXT 0)"
BACKUP_ALLOW_LOCAL_ONLY="$(lire_env BACKUP_ALLOW_LOCAL_ONLY 0)"
BACKUP_RCLONE_CHECK_DOWNLOAD="$(lire_env BACKUP_RCLONE_CHECK_DOWNLOAD 0)"
R2_BUCKET_NAME="$(lire_env R2_BUCKET_NAME)"
UPLOAD_DIR="$(lire_env UPLOAD_DIR ./uploads)"

# ── Chiffrement : obligatoire sauf dérogation explicite ─────────────────────
ARGS_AGE=()
if [ -n "$BACKUP_AGE_RECIPIENT" ]; then
    command -v age >/dev/null 2>&1 || mourir "age introuvable (apt install age)."
    if [ -f "$BACKUP_AGE_RECIPIENT" ]; then
        ARGS_AGE=(-R "$BACKUP_AGE_RECIPIENT")
    else
        for destinataire in ${BACKUP_AGE_RECIPIENT//,/ }; do
            [[ "$destinataire" =~ ^age1[0-9a-z]{58}$ ]] \
                || mourir "BACKUP_AGE_RECIPIENT : « $destinataire » n'est pas une clé publique age."
            ARGS_AGE+=(-r "$destinataire")
        done
    fi
    [ "${#ARGS_AGE[@]}" -gt 0 ] || mourir "BACKUP_AGE_RECIPIENT ne contient aucune clé."
    EXT_CHIFFRE=".age"
elif [ "$BACKUP_ALLOW_PLAINTEXT" = "1" ]; then
    avertir "BACKUP_AGE_RECIPIENT absent et BACKUP_ALLOW_PLAINTEXT=1 : sauvegarde EN CLAIR (développement uniquement)."
    EXT_CHIFFRE=""
else
    mourir "BACKUP_AGE_RECIPIENT absent : refus de produire une sauvegarde en clair (voir docs/EXPLOITATION.md)."
fi

# Chiffre l'entrée standard vers le fichier $1 (ou copie en clair si dérogation).
chiffrer_vers() {
    if [ -n "$EXT_CHIFFRE" ]; then
        age "${ARGS_AGE[@]}" -o "$1"
    else
        cat > "$1"
    fi
}

# ── Préparation ──────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
# Une seule sauvegarde à la fois (cron + deploy.sh).
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || mourir "une autre sauvegarde est en cours."

HORODATAGE="$(date +%Y%m%d_%H%M%S)"
FICHIER_DB="$BACKUP_DIR/${DB_NAME}_db_${HORODATAGE}.dump${EXT_CHIFFRE}"
FICHIER_UP="$BACKUP_DIR/${DB_NAME}_uploads_${HORODATAGE}.tar${EXT_CHIFFRE}"
PRODUITS=()
PARTIELS=()
LISTE=""

a_la_sortie() {
    local code=$? f
    for f in "${PARTIELS[@]}"; do rm -f -- "$f"; done
    [ -n "$LISTE" ] && rm -f -- "$LISTE"
    [ "$code" -eq 0 ] || printf '%s %s ÉCHEC (code %s)\n' "$PREFIXE_JOURNAL" "$(date -Is)" "$code" >&2
}
trap a_la_sortie EXIT

# Le flux est écrit dans un fichier .partial puis renommé : un fichier final
# n'existe que si toute la chaîne (dump | chiffrement) a réussi (pipefail).
finaliser() {
    local partiel="$1" final="$2"
    [ -s "$partiel" ] || mourir "fichier vide : $final"
    mv -f -- "$partiel" "$final"
    (cd "$BACKUP_DIR" && sha256sum -- "$(basename "$final")" > "$(basename "$final").sha256")
    PRODUITS+=("$final" "$final.sha256")
    journal "OK : $(basename "$final") ($(du -h "$final" | cut -f1), sha256 $(cut -c1-16 < "$final.sha256")…)"
}

# ── 1. Base PostgreSQL ───────────────────────────────────────────────────────
journal "Sauvegarde de la base $DB_NAME…"
PARTIELS+=("$FICHIER_DB.partial")
pg_cmd pg_dump -d "$DB_NAME" -Fc --no-owner | chiffrer_vers "$FICHIER_DB.partial"
finaliser "$FICHIER_DB.partial" "$FICHIER_DB"

# ── 2. Fichiers téléversés ───────────────────────────────────────────────────
if [ -n "$R2_BUCKET_NAME" ]; then
    journal "Stockage R2 actif (bucket $R2_BUCKET_NAME) : fichiers téléversés NON inclus ici ;"
    journal "  leur protection repose sur le versionnage / la réplication du bucket (docs/EXPLOITATION.md)."
else
    journal "Sauvegarde des fichiers téléversés…"
    PARTIELS+=("$FICHIER_UP.partial")
    if command -v docker >/dev/null 2>&1 && [ -n "$(docker compose -f "$COMPOSE_FICHIER" ps -q backend 2>/dev/null)" ]; then
        # Volume gestion_imo_uploads, monté sur /app/uploads dans le conteneur API.
        docker compose -f "$COMPOSE_FICHIER" exec -T backend tar -C /app/uploads -cf - . \
            | chiffrer_vers "$FICHIER_UP.partial"
    elif postgres_en_docker; then
        # Pile Docker présente mais API arrêtée : conteneur jetable monté sur le même volume.
        docker compose -f "$COMPOSE_FICHIER" run --rm --no-deps -T --entrypoint tar \
            backend -C /app/uploads -cf - . \
            | chiffrer_vers "$FICHIER_UP.partial"
    else
        case "$UPLOAD_DIR" in /*) ;; *) UPLOAD_DIR="$RACINE/${UPLOAD_DIR#./}" ;; esac
        [ -d "$UPLOAD_DIR" ] || mourir "UPLOAD_DIR introuvable : $UPLOAD_DIR"
        tar -C "$UPLOAD_DIR" -cf - . | chiffrer_vers "$FICHIER_UP.partial"
    fi
    finaliser "$FICHIER_UP.partial" "$FICHIER_UP"
fi
PARTIELS=()

# ── 3. Rétention locale ──────────────────────────────────────────────────────
while IFS= read -r ancien; do
    journal "rétention locale ($RETENTION_JOURS j) : suppression de $(basename "$ancien")"
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "${DB_NAME}_*" -mtime +"$RETENTION_JOURS" -print -delete)

# ── 4. Copie hors site ───────────────────────────────────────────────────────
if [ -z "$BACKUP_RCLONE_REMOTE" ]; then
    if [ "$BACKUP_ALLOW_LOCAL_ONLY" = "1" ]; then
        avertir "BACKUP_RCLONE_REMOTE absent et BACKUP_ALLOW_LOCAL_ONLY=1 : AUCUNE copie hors site."
        exit 0
    fi
    avertir "BACKUP_RCLONE_REMOTE absent : sauvegarde locale seulement, NON conforme (docs/EXPLOITATION.md)."
    exit 3
fi
command -v rclone >/dev/null 2>&1 || { avertir "rclone introuvable : copie hors site impossible."; exit 3; }

LISTE="$(mktemp)"
for f in "${PRODUITS[@]}"; do basename "$f"; done > "$LISTE"

journal "Copie hors site vers $BACKUP_RCLONE_REMOTE ($(wc -l < "$LISTE") fichiers)…"
# --immutable : n'écrase jamais un objet distant existant (complète l'Object Lock).
if ! rclone copy "$BACKUP_DIR" "$BACKUP_RCLONE_REMOTE" --files-from "$LISTE" \
        --immutable --retries 5 --low-level-retries 10 -q; then
    avertir "échec de rclone copy."
    exit 3
fi

# Vérification : taille + somme du fournisseur (MD5 S3/R2 pour les envois
# simples ; taille seule pour les envois multipart), ou relecture complète
# avec BACKUP_RCLONE_CHECK_DOWNLOAD=1.
ARGS_CHECK=(--one-way --files-from "$LISTE" -q)
if [ "$BACKUP_RCLONE_CHECK_DOWNLOAD" = "1" ]; then ARGS_CHECK+=(--download); fi
if ! rclone check "$BACKUP_DIR" "$BACKUP_RCLONE_REMOTE" "${ARGS_CHECK[@]}"; then
    avertir "la copie distante ne correspond pas aux fichiers locaux."
    exit 3
fi
journal "Copie hors site vérifiée. Rétention distante : règle de cycle de vie du bucket (docs/EXPLOITATION.md)."
journal "Sauvegarde terminée."
