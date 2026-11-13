#!/usr/bin/env bash
# Findings only, except: a fresh edge with no Docker gets Docker (the origin never does — it is shared).
set -u
. "$(dirname "$0")/_lib.sh"
section "Preflight: $TARGET"
info "host: $(hostname)  $(uname -sr)   user: $(id -un)   dir: $REMOTE_DIR"
if ! have docker; then
  if [ "$TARGET" = edge ] && [ "$(id -u)" = 0 ]; then
    info "installing Docker"; curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 && success "docker installed" || warn "docker install failed"
  else warn "docker not found — install it first"; fi
fi
have docker && docker compose version >/dev/null 2>&1 && success "docker compose present" || warn "docker compose missing"
have tmux || warn "tmux not found — the troubleshooter runs inside it"
busy() { ss -ltnu 2>/dev/null | awk '{print $5}' | grep -Eq "[:.]$1\$"; }
if [ "$TARGET" = origin ]; then
  if busy "$ORIGIN_PORT" && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^ofhuntsville-'; then
    warn "port $ORIGIN_PORT is taken by something else — change origin.port"
  else success "port $ORIGIN_PORT free (or ours)"; fi
  info "other compose projects here stay untouched: $(docker compose ls -q 2>/dev/null | grep -v '^ofhuntsville$' | tr '\n' ' ')"
else
  for p in 80 443; do busy $p && ! docker ps --format '{{.Names}}' | grep -q '^ofhuntsville-edge-' && warn "port $p is taken" || success "port $p ok"; done
  [ -n "$EDGE_IP" ] || warn "edge.ip is empty — set it to this server's public IP"
fi
exit 0
