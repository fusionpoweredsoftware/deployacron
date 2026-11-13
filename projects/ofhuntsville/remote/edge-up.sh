#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
cd "$REMOTE_DIR/edge"
section "Edge: Caddy, PowerDNS, sync"
[ -n "$EDGE_IP" ] || fail "edge.ip is empty"
umask 077
cat > .env <<ENV
ROOT_DOMAIN=$ROOT_DOMAIN
DNSAPI_HOST=$DNSAPI_HOST
ACME_EMAIL=$ACME_EMAIL
EDGE_IP=$EDGE_IP
ORIGIN=$ORIGIN
EDGE_TOKEN=$EDGE_TOKEN
PDNS_AUTH_API_KEY=$PDNS_AUTH_API_KEY
APEX_IP=$APEX_IP
WWW_CNAME=$WWW_CNAME
ENV
docker compose up -d 2>&1 | tail -n 5
sleep 4
./zone.sh && success "zone $ROOT_DOMAIN set" || warn "zone step failed — run edge/zone.sh by hand"
