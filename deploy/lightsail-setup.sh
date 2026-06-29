#!/usr/bin/env bash
# First-boot setup for an Ubuntu 22.04 LTS AWS Lightsail instance.
# Installs Docker + the compose plugin, opens the firewall, and prepares the app.
# Run as the default `ubuntu` user:  bash deploy/lightsail-setup.sh
set -euo pipefail

echo "==> Installing Docker Engine + compose plugin"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git ufw
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"

echo "==> Configuring host firewall (also open 22/80/443 in the Lightsail console)"
sudo ufw allow 22/tcp || true
sudo ufw allow 80/tcp || true
sudo ufw allow 443/tcp || true
sudo ufw --force enable || true

echo "==> Done. Log out/in (for docker group), then:"
echo "    git clone <your-repo> mx2 && cd mx2"
echo "    cp .env.production.example .env.production   # then edit secrets"
echo "    docker compose -f docker-compose.prod.yml up -d --build"
