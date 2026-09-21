#!/usr/bin/env bash
# Rebuild /etc/caddy/Caddyfile from domains.conf and reload Caddy. Run as root
# on the server (update.sh and install.sh do this for you). If the new file
# doesn't validate, the live one is left alone.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/domains.conf"
: "${PRIMARY:?domains.conf must set PRIMARY}"

sites="$PRIMARY"
for d in ${ALIASES:-}; do sites+=", $d"; done

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
sed "s/__SITES__/${sites}/" "$DIR/Caddyfile" > "$tmp"
for d in ${REDIRECTS:-}; do
  printf '\n%s {\n\tredir https://%s{uri} permanent\n}\n' "$d" "$PRIMARY" >> "$tmp"
done

caddy validate --config "$tmp" --adapter caddyfile >/dev/null
if ! cmp -s "$tmp" /etc/caddy/Caddyfile 2>/dev/null; then
  install -m 644 "$tmp" /etc/caddy/Caddyfile
  systemctl reload caddy
  echo "caddy now serving: $sites${REDIRECTS:+  (redirecting: $REDIRECTS)}"
else
  echo "caddy already up to date: $sites"
fi
