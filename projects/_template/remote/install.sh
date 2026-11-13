#!/usr/bin/env bash
# Runs on the server after the push, from anywhere; $REMOTE_DIR is the code.
# Every project variable is in the environment upper-cased (app.port → APP_PORT),
# plus whatever project.json's "env" renders.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
cd "$REMOTE_DIR"
section "Install & start ${APP_NAME:-app}"
info "this is the placeholder install step — replace it with your own"
[ -f package.json ] && { info "npm install"; npm install --omit=dev --no-audit --no-fund --color=always 2>&1 | tail -n 3; }
todo "start ${APP_NAME:-the app} on :${APP_PORT:-?} (a systemd unit, docker compose, pm2 — whatever this project uses)"
success "install step finished"
