#!/usr/bin/env bash
# Certbot deploy hook: deliver renewed public certificate material to Caddy.
# The Cloudflare credential remains in Certbot's root-only credentials file.
set -euo pipefail

: "${RENEWED_LINEAGE:?Certbot did not provide RENEWED_LINEAGE}"
[ -f /etc/caddy/moni.env ] || { echo "missing /etc/caddy/moni.env" >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/caddy/moni.env
: "${MONI_DOMAIN:?MONI_DOMAIN unset in /etc/caddy/moni.env}"
export MONI_DOMAIN
[ -f "$RENEWED_LINEAGE/fullchain.pem" ] || { echo "missing renewed full chain" >&2; exit 1; }
[ -f "$RENEWED_LINEAGE/privkey.pem" ] || { echo "missing renewed private key" >&2; exit 1; }

install -d -o root -g caddy -m 750 /etc/caddy/certs
install -o root -g caddy -m 640 "$RENEWED_LINEAGE/fullchain.pem" /etc/caddy/certs/fullchain.pem
install -o root -g caddy -m 640 "$RENEWED_LINEAGE/privkey.pem" /etc/caddy/certs/privkey.pem
/usr/bin/caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
