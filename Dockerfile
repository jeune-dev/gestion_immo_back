# ============================================================
#  Gestion Immo API — image de production multi-étapes
#  (même structure que Widjila et Sign)
# ============================================================

# ── Étape 1 : dépendances de production ──────────────────────────────────────
FROM node:22.20.0-slim AS deps
WORKDIR /app
COPY package*.json ./
# Outils de compilation : repli de bcrypt si aucun binaire précompilé ne
# correspond à la plateforme (ils ne vont PAS dans l'image finale).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# --ignore-scripts : aucun script d'installation de dépendance n'est exécuté
# (réduit la surface d'attaque « chaîne d'approvisionnement ») :
#   - sharp 0.35 : binaires fournis par les paquets optionnels @img/sharp-*,
#     pas de script d'installation ;
#   - @firebase/util (postinstall : configuration du SDK web, sans objet côté
#     serveur) et protobufjs (postinstall : contrôle de version de sa CLI) ne
#     sont pas nécessaires à l'exécution ;
# SAUF bcrypt, dont le script `install` (node-gyp-build) choisit le binaire
# précompilé ou le compile : il est rejoué explicitement, et lui seul.
# Le chargement de bcrypt et sharp est vérifié dès la construction.
RUN npm ci --omit=dev --no-fund --ignore-scripts \
    && npm rebuild bcrypt \
    && node -e "require('bcrypt'); require('sharp')"

# ── Étape 2 : image finale ───────────────────────────────────────────────────
FROM node:22.20.0-slim AS runner
# Polices pour les PDF (pdfkit). Pas de curl : le HEALTHCHECK utilise fetch de Node.
RUN apt-get update && apt-get install -y --no-install-recommends \
        fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Gestionnaires de paquets inutiles à l'exécution (l'entrypoint appelle
# node_modules/.bin directement) : moins de surface d'attaque et moins de CVE
# remontées par Trivy (dépendances embarquées de npm).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
RUN mkdir -p logs uploads && chown -R node:node /app \
    && sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh
USER node
EXPOSE 3000

# Interroge l'adresse réseau du conteneur (et non sa loopback) : un process
# lié par erreur à 127.0.0.1 est détecté comme injoignable (leçon de Widjila).
# fetch natif de Node 22 : pas de curl dans l'image finale.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD ["node", "-e", "const i=Object.values(require('os').networkInterfaces()).flat().find(x=>x.family==='IPv4'&&!x.internal);if(!i)process.exit(1);fetch('http://'+i.address+':3000/health',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Attente de la base, migrations, initialisation, puis démarrage.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
