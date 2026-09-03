#!/usr/bin/env bash
# Verify a live deployment from the outside, the way a phone would see it.
#
#   deploy/preflight.sh https://tt.yourdomain.at [referee-key]
#
# Run it after installing, again the day before the event, and once on the
# morning of. Everything it checks has a plausible way of being broken by a
# change you forgot you made.

set -uo pipefail
BASE="${1:?usage: preflight.sh <https://your-url> [referee-key]}"
BASE="${BASE%/}"
REF="${2:-}"
PASS=0; FAIL=0; WARN=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; WARN=$((WARN+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

HOST="$(printf '%s' "$BASE" | sed -E 's#^https?://##; s#[:/].*##')"
SCHEME="$(printf '%s' "$BASE" | sed -E 's#://.*##')"

# ---------------------------------------------------------------- reachable
head_ "Reachability"
if printf '%s' "$HOST" | grep -qE '^[0-9.]+$|^localhost$'; then
  ok "$HOST is a literal address, no DNS needed"
elif getent hosts "$HOST" >/dev/null 2>&1 || host "$HOST" >/dev/null 2>&1; then
  ok "$HOST resolves to $(getent hosts "$HOST" | awk '{print $1}' | head -1)"
else
  bad "$HOST does not resolve — check the A record, and give DNS an hour"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/" || echo 000)
[ "$code" = 200 ] && ok "spectator page returns 200" || bad "spectator page returned $code"

t=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 "$BASE/" || echo 9)
awk -v t="$t" 'BEGIN{exit !(t<1.5)}' && ok "loads in ${t}s" || warn "slow first byte: ${t}s"

# --------------------------------------------------------------------- TLS
if [ "$SCHEME" = https ]; then
  head_ "HTTPS"
  if curl -sS --max-time 10 -o /dev/null "$BASE/" 2>/dev/null; then
    ok "certificate is valid and trusted"
  else
    bad "TLS failed — Caddy needs port 80 open to renew certificates"
  fi
  exp=$(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "$exp" ]; then
    left=$(( ( $(date -d "$exp" +%s) - $(date +%s) ) / 86400 ))
    [ "$left" -gt 14 ] && ok "certificate valid for $left more days" \
                       || warn "certificate expires in $left days"
  fi
  r=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$HOST/" || echo 000)
  [ "$r" = 301 ] || [ "$r" = 302 ] || [ "$r" = 308 ] \
    && ok "plain http redirects to https ($r)" \
    || warn "http returned $r — people typing the URL without https may land nowhere"
else
  warn "no TLS — phones will show a 'not secure' warning"
fi

# ------------------------------------------------------------------ assets
head_ "Assets"
for f in /static/app.js /static/style.css; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE$f" || echo 000)
  [ "$c" = 200 ] && ok "$f" || bad "$f returned $c"
done

# ------------------------------------------------------------------- state
head_ "State API"
body=$(curl -s --max-time 10 -D /tmp/.pf_h "$BASE/api/state" || true)
if printf '%s' "$body" | grep -q '"version"'; then
  ok "state endpoint returns JSON ($(printf '%s' "$body" | wc -c) bytes)"
else
  bad "state endpoint did not return usable JSON"
fi
etag=$(grep -i '^etag:' /tmp/.pf_h 2>/dev/null | tr -d '\r' | cut -d' ' -f2-)
if [ -n "$etag" ]; then
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        -H "If-None-Match: $etag" "$BASE/api/state")
  [ "$c" = 304 ] && ok "unchanged state returns 304 (saves people's data)" \
                 || warn "expected 304, got $c — clients will refetch needlessly"
fi

# --------------------------------------------------------------------- SSE
head_ "Live updates"
sse=$(curl -s --max-time 6 -N -H 'Accept: text/event-stream' "$BASE/api/stream" \
      2>/dev/null | head -c 200 || true)
if printf '%s' "$sse" | grep -qE '^(data:|: ping)'; then
  ok "server-sent events stream through"
else
  bad "no SSE data — a proxy is buffering /api/stream (needs flush_interval -1)"
fi

# --------------------------------------------------------------- roles, QR
head_ "Permissions"
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
      -H 'Content-Type: application/json' \
      -d '{"op":"add_player","data":{"name":"preflight"}}' "$BASE/api/action")
[ "$c" = 403 ] && ok "strangers cannot change anything" \
               || bad "anonymous write returned $c — expected 403"

if [ -n "$REF" ]; then
  role=$(curl -s --max-time 10 -H "X-Key: $REF" "$BASE/api/state" \
         | grep -o '"role": *"[a-z]*"' | head -1 | grep -o '[a-z]*"$' | tr -d '"')
  [ "$role" = referee ] && ok "referee key works" \
                        || bad "referee key gave role '${role:-none}'"
fi

head_ "Poster"
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      "$BASE/api/qr.svg?u=$(printf '%s' "$BASE/" | sed 's#:#%3A#g; s#/#%2F#g')")
[ "$c" = 200 ] && ok "QR code renders" \
               || warn "QR returned $c — run 'pip install segno' on the server"

printf '\n  %d passed, %d warnings, %d failed\n\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
