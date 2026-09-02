#!/usr/bin/env bash
# Push a new version. The event log lives in /var/lib and is untouched.
set -euo pipefail
HOST="${1:?usage: update.sh user@your-server}"
rsync -a --delete --exclude data --exclude __pycache__ --exclude '*.db' \
      ./ "${HOST}:/opt/tt-console/"
ssh "$HOST" 'chown -R tt:tt /opt/tt-console && systemctl restart tt-console'
echo "deployed"
