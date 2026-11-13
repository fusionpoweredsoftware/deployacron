#!/usr/bin/env bash
# Bring this checkout to the tip of one branch, on the server, from GitHub.
#
# Nothing is copied from the machine running the deployer: the server does the
# fetching, with its own credential. That is why the deploy needs no rsync and
# why what lands here is exactly what is in the branch — not whatever state a
# working copy on somebody's laptop happened to be in.
#
#   GIT_URL        the remote, ssh or https
#   GIT_BRANCH     the branch to deploy
#   GIT_KEY        path to a deploy key ON THIS SERVER (optional; when empty and
#                  the server cannot read an ssh remote, one is made at
#                  ~/.ssh/deploy-$PROJECT and the run asks for it to be added)
#   GIT_TOKEN      token for an https remote (optional; never written to disk)
#   GIT_DEPTH      shallow clone depth, 0 or empty for a full clone
#   GIT_SUBMODULES 1 to update submodules too
#   REMOTE_DIR     where the checkout lives
set -euo pipefail
. "$(dirname "$0")/_lib.sh" 2>/dev/null || {
  BOLD='\033[1m'; DIM='\033[2m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  RED='\033[0;31m'; CYAN='\033[0;36m'; MAGENTA='\033[0;35m'; RESET='\033[0m'
  info() { echo -e "  ${CYAN}i${RESET}  $1"; }; success() { echo -e "  ${GREEN}✓${RESET}  $1"; }
  warn() { echo -e "  ${YELLOW}!${RESET}  $1"; }; fail() { echo -e "  ${RED}x${RESET}  $1"; exit 1; }
  section() { echo ""; echo -e "${CYAN}${BOLD}  ── $1${RESET}"; echo ""; }
  have() { command -v "$1" >/dev/null 2>&1; }
}
: "${REMOTE_DIR:?}" "${GIT_URL:?no repository configured — set it in Settings → Project}" "${GIT_BRANCH:?}"

# ~ arrives as a literal character in an environment value — no shell has had a
# chance to expand it — so a key at ~/.ssh/id_gh would be looked for in a
# directory called "~". Expanded here, where $HOME is the server's.
expand_home() { case "${1:-}" in "~") printf '%s' "$HOME" ;; "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;; *) printf '%s' "${1:-}" ;; esac; }
GIT_KEY="$(expand_home "${GIT_KEY:-}")"
REMOTE_DIR="$(expand_home "$REMOTE_DIR")"

# No key set, no token, an ssh remote: this server's own key for this project,
# made on demand. A key set in Settings always wins and is never second-guessed.
AUTO_KEY="$HOME/.ssh/deploy-${PROJECT:-deploy}"
AUTO=""
case "$GIT_URL" in git@*|ssh://*) [ -z "$GIT_KEY" ] && [ -z "${GIT_TOKEN:-}" ] && AUTO=1 ;; esac
[ -n "$AUTO" ] && [ -r "$AUTO_KEY" ] && GIT_KEY="$AUTO_KEY"

section "Fetch ${GIT_BRANCH} from ${GIT_URL}"
have git || fail "git is not installed on this server"

# The credential. A key is used only for this command, never added to an agent
# or written into the repo's config; BatchMode so a missing key fails loudly
# instead of hanging on a passphrase prompt nobody can answer.
if [ -n "${GIT_KEY:-}" ]; then
  [ -r "$GIT_KEY" ] || fail "deploy key not readable on this server: $GIT_KEY"
  export GIT_SSH_COMMAND="ssh -i ${GIT_KEY} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
  info "deploy key: ${BOLD}${GIT_KEY}${RESET}"
else
  export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
fi
# An https remote with a token: passed per command in the environment through
# an askpass helper, so it is never in the URL, the reflog, or `ps`.
ASKPASS=""
if [ -n "${GIT_TOKEN:-}" ]; then
  ASKPASS="$(mktemp)"; chmod 700 "$ASKPASS"
  printf '#!/bin/sh\ncase "$1" in Username*) echo "x-access-token";; *) printf "%%s" "$GIT_TOKEN";; esac\n' > "$ASKPASS"
  export GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0
  trap 'rm -f "$ASKPASS"' EXIT
  info "authenticating with a token"
fi
export GIT_CONFIG_PARAMETERS="'color.ui=always'"

if [ -n "$AUTO" ]; then
  ERRF="$(mktemp)"
  if ! git ls-remote --heads "$GIT_URL" "$GIT_BRANCH" >/dev/null 2>"$ERRF"; then
    if grep -qiE 'permission denied|could not read from remote|repository not found' "$ERRF"; then
      if [ ! -r "$AUTO_KEY" ]; then
        have ssh-keygen || fail "this server cannot read the repository, and has no ssh-keygen to make a deploy key — set one in Settings"
        mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
        ssh-keygen -q -t ed25519 -N "" -C "deployacron ${PROJECT:-deploy}@$(hostname)" -f "$AUTO_KEY"
        success "made a deploy key for this server: ${BOLD}${AUTO_KEY}${RESET}"
      fi
      warn "this server cannot read ${GIT_URL} yet — add its key to the repository"
      printf '::deployacron-key:: %s %s\n' "$AUTO_KEY" "$(cat "$AUTO_KEY.pub")"
      rm -f "$ERRF"; exit 75
    fi
  fi
  rm -f "$ERRF"
fi

DEPTH_ARGS=()
[ -n "${GIT_DEPTH:-}" ] && [ "${GIT_DEPTH:-0}" != "0" ] && DEPTH_ARGS=(--depth "$GIT_DEPTH")

if [ -d "$REMOTE_DIR/.git" ]; then
  cd "$REMOTE_DIR"
  # The remote may have been repointed in Settings since the last deploy.
  git remote set-url origin "$GIT_URL" 2>/dev/null || git remote add origin "$GIT_URL"
  BEFORE="$(git rev-parse --short HEAD 2>/dev/null || echo none)"
  info "fetching origin/${GIT_BRANCH}"
  git fetch --prune "${DEPTH_ARGS[@]}" origin "$GIT_BRANCH"
  git checkout -q -B "$GIT_BRANCH" "origin/$GIT_BRANCH"
  git reset --hard "origin/$GIT_BRANCH"
  # Untracked leftovers go; ignored files stay, because that is where this
  # deployment's own secrets live (settings.json, .env). .deploy is the
  # deployer's own directory and is not the repository's to remove.
  git clean -fd -e .deploy
  AFTER="$(git rev-parse --short HEAD)"
  if [ "$BEFORE" = "$AFTER" ]; then
    success "already at ${BOLD}${AFTER}${RESET} — nothing new on ${GIT_BRANCH}"
  else
    success "${BEFORE} → ${BOLD}${AFTER}${RESET}"
    echo ""
    git --no-pager log --oneline --no-decorate "${BEFORE}..${AFTER}" 2>/dev/null | head -n 20 | sed 's/^/      /' || true
    echo ""
    info "$(git --no-pager diff --shortstat "${BEFORE}" "${AFTER}" 2>/dev/null || echo 'files changed: unknown')"
  fi
else
  [ -e "$REMOTE_DIR" ] && [ -n "$(ls -A "$REMOTE_DIR" 2>/dev/null | grep -v '^\.deploy$' || true)" ] \
    && fail "$REMOTE_DIR exists and is not a git checkout — move it aside, or point the project at another directory"
  mkdir -p "$REMOTE_DIR"
  info "cloning ${GIT_BRANCH} into ${REMOTE_DIR}"
  # Clone beside, then move in, so an existing .deploy/ survives a first clone.
  TMP="$(mktemp -d "${REMOTE_DIR%/}.clone.XXXXXX")"
  git clone "${DEPTH_ARGS[@]}" --branch "$GIT_BRANCH" "$GIT_URL" "$TMP"
  ( shopt -s dotglob; mv "$TMP"/* "$REMOTE_DIR"/ )
  rmdir "$TMP"
  cd "$REMOTE_DIR"
  success "cloned at ${BOLD}$(git rev-parse --short HEAD)${RESET}"
fi

[ "${GIT_SUBMODULES:-}" = "1" ] && { info "submodules"; git submodule update --init --recursive; }

echo ""
info "branch  ${BOLD}$(git rev-parse --abbrev-ref HEAD)${RESET}   commit ${BOLD}$(git rev-parse --short HEAD)${RESET}"
info "$(git --no-pager log -1 --format='%an, %ar — %s')"
# What the run record and the templates can quote.
git rev-parse HEAD > "$REMOTE_DIR/.deploy/COMMIT" 2>/dev/null || true
success "checkout is at the tip of ${GIT_BRANCH}"
