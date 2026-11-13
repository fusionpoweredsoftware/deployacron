#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
cd "$REMOTE_DIR/origin"
section "Origin: site manager"
[ -n "$ADMIN_PASSWORD" ] || warn "admin.password is empty — the manager will stay shut"
[ -n "$MANAGE_PATH" ] || warn "manage.path is empty — the manager answers at the bare address"
umask 077
cat > .env <<ENV
ROOT_DOMAIN=$ROOT_DOMAIN
EDGE_TOKEN=$EDGE_TOKEN
ADMIN_USER=$ADMIN_USER
ADMIN_PASSWORD=$ADMIN_PASSWORD
PDNS_API_KEY=$PDNS_API_KEY
MANAGE_PATH=$MANAGE_PATH
ZAI_API_KEY=${ZAI_APIKEY:-}
ZAI_MODEL=${ZAI_MODEL:-glm-5.3}
ZAI_URL=${ZAI_URL:-https://api.z.ai/api/anthropic}
ORIGIN_PORT=$ORIGIN_PORT
ENV
docker compose up -d --build 2>&1 | tail -n 5
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$ORIGIN_PORT/healthz" >/dev/null 2>&1 && { success "manager up on :$ORIGIN_PORT"; exit 0; }; sleep 1; done
fail "manager did not answer on :$ORIGIN_PORT"
