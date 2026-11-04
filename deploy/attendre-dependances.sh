#!/usr/bin/env bash
# ============================================================================
#  Démarre les dépendances de l'API (postgres, redis) et attend qu'elles
#  soient SAINES avant de lancer le backend.
#
#  Usage : bash deploy/attendre-dependances.sh postgres redis
#
#  Pourquoi ce script, alors que le compose déclare déjà
#  `depends_on: { condition: service_healthy }` ?
#
#  Parce que cette condition n'attend pas : `docker compose up backend` échoue
#  IMMÉDIATEMENT si une dépendance est marquée `unhealthy` à la seconde où il
#  regarde. Sur un VPS modeste, la construction de l'image sature la machine
#  pendant plusieurs minutes ; `pg_isready` et `redis-cli ping` dépassent alors
#  leur délai, le conteneur est déclaré mort alors qu'il sert toujours, et le
#  déploiement s'arrête sur :
#
#      dependency failed to start: container …-redis-1 is unhealthy
#
#  Ici on ATTEND qu'elle redevienne saine, on la recrée UNE fois si l'attente
#  ne suffit pas (conteneur tué par le gestionnaire de mémoire, resté bloqué),
#  et en dernier recours on affiche la sortie des sondes et les journaux — un
#  « unhealthy » sans explication ne dit pas quoi réparer.
#
#  Effet de bord utile : `up -d` réconcilie les conteneurs avec le fichier
#  compose. Un `up -d backend` seul ne le fait jamais pour les dépendances, si
#  bien qu'une correction de leur `command` ou de leur `healthcheck` restait
#  sans effet sur le serveur.
# ============================================================================
set -euo pipefail

# shellcheck source=deploy/_commun.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_commun.sh"
PREFIXE_JOURNAL="[dependances]"

# Par dépendance, et par tentative. 10 sondes × 10 s de délai = une dépendance
# réellement morte est déclarée telle bien avant.
DELAI_MAX="${DELAI_MAX:-180}"

services=("$@")
[ "${#services[@]}" -gt 0 ] || mourir "Usage : bash deploy/attendre-dependances.sh postgres redis"
command -v docker >/dev/null 2>&1 || mourir "docker introuvable."

compose() { docker compose -f "$COMPOSE_FICHIER" "$@"; }

# « sans_sonde » : un service sans HEALTHCHECK ne peut pas être attendu — le
# considérer prêt dès qu'il tourne est le mieux qu'on puisse faire, et c'est
# déjà ce que fait `depends_on` dans ce cas.
etat_sante() {
    docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{if .State.Running}}sans_sonde{{else}}arrete{{end}}{{end}}' "$1" 2>/dev/null || printf 'absent'
}

diagnostic() {
    local service="$1" cid="$2"
    avertir "« $service » n'est pas sain. Sortie des dernières sondes :"
    docker inspect -f '{{range .State.Health.Log}}─ code {{.ExitCode}} ({{.Start}}) : {{.Output}}{{end}}' "$cid" 2>&1 | tail -n 20 >&2 || true
    # OOMKilled : la cause la plus probable sur un VPS serré, et invisible dans
    # les journaux du conteneur (le processus est tué, il n'écrit rien).
    avertir "OOMKilled=$(docker inspect -f '{{.State.OOMKilled}}' "$cid" 2>/dev/null || true) redémarrages=$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || true)"
    avertir "Journaux de « $service » :"
    compose logs --tail=40 "$service" >&2 || true
}

attendre() {
    local service="$1" limite=$((SECONDS + DELAI_MAX)) cid etat=absent
    while [ "$SECONDS" -lt "$limite" ]; do
        cid="$(compose ps -q "$service" 2>/dev/null || true)"
        if [ -n "$cid" ]; then
            etat="$(etat_sante "$cid")"
            case "$etat" in
                healthy|sans_sonde) journal "« $service » : $etat."; return 0 ;;
            esac
        fi
        sleep 3
    done
    journal "« $service » : $etat après ${DELAI_MAX}s."
    return 1
}

compose up -d --no-build "${services[@]}"

for service in "${services[@]}"; do
    attendre "$service" && continue

    cid="$(compose ps -q "$service" 2>/dev/null || true)"
    [ -n "$cid" ] && diagnostic "$service" "$cid"

    avertir "Recréation de « $service » et seconde attente."
    compose up -d --no-build --force-recreate "$service"
    if ! attendre "$service"; then
        cid="$(compose ps -q "$service" 2>/dev/null || true)"
        [ -n "$cid" ] && diagnostic "$service" "$cid"
        mourir "« $service » toujours pas sain : le problème n'est pas passager, lire les sondes ci-dessus."
    fi
done

journal "Dépendances saines : ${services[*]}."
