#!/usr/bin/env bash
# Run once per server before its first deploy: Settings → Server → Install prerequisites.
# Installs only what is missing (Docker + compose, Node.js, git, curl, tmux, and the troubleshooter: Ollama + Claude Code). Touches nothing else.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
echo "checking $(hostname): git curl tmux node docker"
need=()
for c in git curl tmux; do command -v $c >/dev/null || need+=($c); done
if [ ${#need[@]} -gt 0 ]; then
  if command -v apt-get >/dev/null; then echo "installing: ${need[*]}"; apt-get update && apt-get install -y "${need[@]}"
  elif command -v dnf >/dev/null; then dnf install -y "${need[@]}"
  else echo "install by hand: ${need[*]}"; exit 1; fi
fi
if ! command -v node >/dev/null; then
  echo "installing Node.js 20"
  if command -v apt-get >/dev/null; then curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
  elif command -v dnf >/dev/null; then curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && dnf install -y nodejs
  else echo "install Node.js by hand"; fi
else echo "node present: $(node -v)"; fi
if ! command -v docker >/dev/null; then
  echo "installing Docker"; curl -fsSL https://get.docker.com | sh
else echo "docker present: $(docker --version)"; fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin missing — install docker-compose-plugin"; exit 1; }
systemctl enable --now docker >/dev/null 2>&1 || true
# The troubleshooter runs "ollama launch claude" in tmux on this server.
if ! command -v ollama >/dev/null; then echo "installing Ollama"; curl -fsSL https://ollama.com/install.sh | sh
else echo "ollama present: $(ollama --version 2>&1 | tail -1)"; fi
if ! command -v claude >/dev/null; then echo "installing Claude Code"; npm install -g @anthropic-ai/claude-code
else echo "claude present: $(claude --version 2>&1 | head -1)"; fi
echo "ready: $(docker --version), $(docker compose version --short), ollama + claude installed"
