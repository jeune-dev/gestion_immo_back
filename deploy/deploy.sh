#!/usr/bin/env bash
# Déploiement sur le VPS (Docker) : récupère le code, reconstruit, redémarre.
# Les migrations sont appliquées par docker-entrypoint.sh AVANT que l'API
# serve du trafic ; si elles échouent, le conteneur ne démarre pas.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
./deploy/backup-postgres.sh || echo "[deploy] Avertissement : sauvegarde préalable impossible"
docker compose -f docker-compose.prod.yml up -d --build
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null; then echo "[deploy] API en ligne"; exit 0; fi
  sleep 2
done
echo "[deploy] ÉCHEC : /health ne répond pas" >&2
docker compose -f docker-compose.prod.yml logs --tail=100 backend >&2
exit 1
