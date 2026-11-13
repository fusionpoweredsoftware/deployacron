#!/usr/bin/env bash
# Shared helpers for the scripts deployacron pushes to the server.
# Consistent colours and shapes, so the remote feed reads like a familiar installer.
BOLD='\033[1m'; DIM='\033[2m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
RED='\033[0;31m'; CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; RESET='\033[0m'
info()    { echo -e "  ${CYAN}i${RESET}  $1"; }
success() { echo -e "  ${GREEN}✓${RESET}  $1"; }
warn()    { echo -e "  ${YELLOW}!${RESET}  $1"; }
fail()    { echo -e "  ${RED}x${RESET}  $1"; exit 1; }
todo()    { echo -e "  ${MAGENTA}□${RESET}  ${BOLD}NOT DONE:${RESET} $1"; }
section() { echo ""; echo -e "${CYAN}${BOLD}  ── $1${RESET}"; echo ""; }
have()    { command -v "$1" >/dev/null 2>&1; }
