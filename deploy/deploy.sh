#!/usr/bin/env bash
# Déploiement sur le VPS (Docker) : récupère le code, reconstruit, redémarre.
# Les migrations sont appliquées par docker-entrypoint.sh AVANT que l'API
# serve du trafic ; si elles échouent, le conteneur ne démarre pas.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only

# `bash <script>` et non `./<script>` : les scripts de deploy/ ne portent pas
# tous le bit d'exécution selon la façon dont le dépôt a été récupéré, et un
# `chmod +x` sur le serveur suffirait à faire échouer le `git pull` suivant
# (git suit le mode des fichiers).
bash deploy/backup-postgres.sh || echo "[deploy] Avertissement : sauvegarde préalable impossible"

# Construire d'abord, remplacer le conteneur ensuite — et attendre les
# dépendances soi-même. `up -d --build` enchaîne tout, et la construction
# sature assez la machine pour que les sondes de postgres et de redis dépassent
# leur délai : `up` refuse alors de démarrer le backend (« dependency failed to
# start: … is unhealthy ») pour des services qui répondent très bien.
docker compose -f docker-compose.prod.yml build backend
bash deploy/attendre-dependances.sh postgres redis
docker compose -f docker-compose.prod.yml up -d --no-build --no-deps --force-recreate backend

# Le port publié sur l'hôte est réglable (HOST_PORT) : un VPS qui héberge
# plusieurs API déplace celui-ci. Le lire plutôt que le supposer, sinon la
# sonde interroge l'application du voisin et le déploiement paraît réussi.
PORT_HOTE="$(grep -E '^HOST_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -dc '0-9')"
PORT_HOTE="${PORT_HOTE:-3000}"
echo "[deploy] Sonde sur 127.0.0.1:${PORT_HOTE}/health"

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT_HOTE}/health" >/dev/null; then echo "[deploy] API en ligne"; exit 0; fi
  sleep 2
done
echo "[deploy] ÉCHEC : /health ne répond pas" >&2
docker compose -f docker-compose.prod.yml logs --tail=100 backend >&2
exit 1
