#!/usr/bin/env bash
# What the server has. Findings only.
set -u
. "$(dirname "$0")/_lib.sh"
section "Server preflight"
info "host:  $(hostname)  $(uname -sr)"
info "user:  $(id -un)"
info "dir:   ${REMOTE_DIR}"
have node   && success "node $(node -v)"     || warn "node not found"
have docker && success "docker present"      || warn "docker not found"
have tmux   && success "tmux present"        || warn "tmux not found — the troubleshooter runs inside it"
exit 0
