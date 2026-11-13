#!/usr/bin/env bash
# Run once per server before its first deploy: Settings → Server → Install prerequisites.
# Installs only what is missing (Docker + compose, git, curl, tmux). Touches nothing else.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
need=()
for c in git curl tmux; do command -v $c >/dev/null || need+=($c); done
if [ ${#need[@]} -gt 0 ]; then
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq "${need[@]}"
  elif command -v dnf >/dev/null; then dnf install -y -q "${need[@]}"
  else echo "install by hand: ${need[*]}"; exit 1; fi
fi
if ! command -v docker >/dev/null; then
  echo "installing Docker"; curl -fsSL https://get.docker.com | sh
else echo "docker present: $(docker --version)"; fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin missing — install docker-compose-plugin"; exit 1; }
systemctl enable --now docker >/dev/null 2>&1 || true
echo "ready: $(docker --version), $(docker compose version --short)"
