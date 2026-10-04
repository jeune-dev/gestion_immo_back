#!/usr/bin/env bash
# Préparation d'un VPS Ubuntu 22.04/24.04 (à lancer une fois, en root).
set -euo pipefail
apt-get update && apt-get -y upgrade
apt-get install -y ca-certificates curl git ufw nginx certbot python3-certbot-nginx fail2ban unattended-upgrades
# Sauvegardes : chiffrement (age) et copie hors site (rclone) — docs/EXPLOITATION.md.
apt-get install -y age rclone
# Docker (dépôt officiel)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
# Pare-feu : SSH + HTTP(S) uniquement (les ports Docker sont publiés sur 127.0.0.1).
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
systemctl enable --now fail2ban
echo "Étapes suivantes (détail : docs/EXPLOITATION.md) : cloner le dépôt dans /opt/gestion-imo,"
echo "créer back/.env depuis .env.example (chmod 600), copier deploy/nginx.conf dans"
echo "/etc/nginx/sites-available/ et deploy/nginx-proxy.conf dans /etc/nginx/snippets/gestion-imo-proxy.conf,"
echo "certbot certonly --nginx, configurer rclone + BACKUP_AGE_RECIPIENT, installer la crontab, puis deploy/deploy.sh."
