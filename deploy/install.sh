#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 24.04 box. Run as root.
#   curl -fsSL https://.../install.sh | bash -s tt.example.at
set -euo pipefail
DOMAIN="${1:?usage: install.sh <your-domain>}"

apt-get update -qq
apt-get install -y -qq python3 python3-pip debian-keyring debian-archive-keyring apt-transport-https curl
pip3 install --break-system-packages -q segno        # optional, for the QR poster

# Caddy: HTTPS with no certificate work on your part
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq && apt-get install -y -qq caddy

id -u tt &>/dev/null || useradd --system --home /opt/tt-console --shell /usr/sbin/nologin tt
mkdir -p /opt/tt-console /var/lib/tt-console
chown -R tt:tt /opt/tt-console /var/lib/tt-console

sed "s/tt\.example\.at/${DOMAIN}/" deploy/Caddyfile > /etc/caddy/Caddyfile
cp deploy/tt-console.service /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now tt-console
systemctl reload caddy

echo
echo "  Live at https://${DOMAIN}"
echo "  Your keys:  cat /var/lib/tt-console/keys.json"
echo
