#!/bin/sh
# ============================================================================
#  Gestion Immo API — point d'entrée du conteneur (repris de Widjila)
#
#  1. attendre PostgreSQL ;
#  2. appliquer les migrations (une migration en échec empêche le démarrage :
#     échec sûr plutôt que schéma incohérent) ;
#  3. rejouer les seeders de référence (idempotents : plans, catégories,
#     modèles) et synchroniser rôles + super admin ;
#  4. créer / mettre à jour le rôle PostgreSQL APPLICATIF à privilèges
#     minimaux (src/scripts/rolesBase.js) ;
#  5. démarrer Node en PID 1 (`exec`) pour recevoir SIGTERM (arrêt propre).
#
#  Séparation des rôles (constat M5 de l'audit) : les étapes 1–4 utilisent le
#  PROPRIÉTAIRE du schéma (DB_ADMIN_USER / DB_ADMIN_PASSWORD) ; l'API tourne
#  avec DB_USER / DB_PASSWORD, rôle sans aucun droit sur le schéma. Sans
#  DB_ADMIN_USER (développement), tout se fait avec DB_USER comme avant.
# ============================================================================
set -e

# Exécute une commande avec les identifiants du propriétaire du schéma.
en_proprietaire() {
    if [ -n "${DB_ADMIN_USER:-}" ]; then
        DB_USER="$DB_ADMIN_USER" DB_PASSWORD="$DB_ADMIN_PASSWORD" "$@"
    else
        "$@"
    fi
}

ATTENTE_MAX="${DB_WAIT_SECONDS:-60}"
echo "[entrypoint] Attente de PostgreSQL (max ${ATTENTE_MAX}s)…"
i=0
while [ "$i" -lt "$ATTENTE_MAX" ]; do
    if en_proprietaire node -e "require('/app/src/config/db.js').authenticate().then(() => process.exit(0)).catch(() => process.exit(1))" 2>/dev/null; then
        echo "[entrypoint] PostgreSQL disponible après ${i}s"
        break
    fi
    i=$((i + 1))
    sleep 1
done
if [ "$i" -ge "$ATTENTE_MAX" ]; then
    echo "[entrypoint] ERREUR : PostgreSQL injoignable — abandon." >&2
    exit 1
fi

echo "[entrypoint] Migrations…"
en_proprietaire ./node_modules/.bin/sequelize-cli db:migrate
echo "[entrypoint] Données de référence…"
en_proprietaire ./node_modules/.bin/sequelize-cli db:seed:all
en_proprietaire node src/scripts/initialiser.js
if [ -n "${DB_ADMIN_USER:-}" ]; then
    echo "[entrypoint] Rôle applicatif « ${DB_USER} » (privilèges minimaux)…"
    DB_APP_USER="$DB_USER" DB_APP_PASSWORD="$DB_PASSWORD" en_proprietaire node src/scripts/rolesBase.js
fi

echo "[entrypoint] Lancement : $*"
exec "$@"
