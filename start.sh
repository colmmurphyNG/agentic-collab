#!/usr/bin/env bash
set -euo pipefail

# ── Agentic Collab Start Script ──
# Starts the orchestrator (Docker) and proxy (host) with zero configuration.
# Detects OS, package managers, and available tools to give targeted guidance.
#
# Flags:
#   --build      Force `docker compose build` even if the container is already
#                running. Use after merging source changes that need to reach
#                the container.
#   --no-build   Never rebuild the image, even if source has changed since the
#                last build. Use for fast proxy/host-only restarts.
#   --dry-run    Print the actions that would be taken (rebuild decision,
#                volume name, port, etc.) and exit before touching anything.
#                Useful for confirming behaviour without side effects.
#   --port <N>   Override the orchestrator host port for this run. Higher
#                priority than the ORCHESTRATOR_HOST_PORT env var and the
#                docker-compose mapping. Useful for running a second
#                conductor instance side-by-side without editing compose.
#
# Default rebuild behaviour: if a `.build-image-sha` file exists and matches
# the current `git rev-parse HEAD`, reuse the cached image. Otherwise rebuild
# automatically. This eliminates the silent-stale-image trap where source
# changes never reach the container after a restart.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Flag Parsing ──

FORCE_BUILD=auto      # auto | yes | no
DRY_RUN=false
PORT_FLAG=""          # set via --port <N>; takes priority over env var if non-empty
i=1
while [ $i -le $# ]; do
  arg="${!i}"
  case "$arg" in
    --build|--rebuild)  FORCE_BUILD=yes ;;
    --no-build)          FORCE_BUILD=no ;;
    --dry-run)           DRY_RUN=true ;;
    --port)
      i=$((i + 1))
      if [ $i -gt $# ]; then
        echo "--port requires a numeric argument (e.g. --port 3099)" >&2
        exit 1
      fi
      PORT_FLAG="${!i}"
      if ! [[ "$PORT_FLAG" =~ ^[0-9]+$ ]]; then
        echo "--port argument must be numeric (got: $PORT_FLAG)" >&2
        exit 1
      fi
      ;;
    --port=*)
      PORT_FLAG="${arg#--port=}"
      if ! [[ "$PORT_FLAG" =~ ^[0-9]+$ ]]; then
        echo "--port argument must be numeric (got: $PORT_FLAG)" >&2
        exit 1
      fi
      ;;
    -h|--help)
      sed -n '4,25p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
  i=$((i + 1))
done

# Colors (if terminal supports it)
if [ -t 1 ]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  DIM='\033[0;90m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' DIM='' RESET=''
fi

info()  { echo -e "${GREEN}[start]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[start]${RESET} $*"; }
fail()  { echo -e "${RED}[start]${RESET} $*"; exit 1; }
step()  { echo -e "${BOLD}──── $* ────${RESET}"; }

# ── Platform Detection ──

OS="$(uname -s)"
HAS_MISE=false
HAS_BREW=false
HAS_APT=false

command -v mise &>/dev/null && HAS_MISE=true
command -v brew &>/dev/null && HAS_BREW=true
command -v apt &>/dev/null && HAS_APT=true

# Build install hint for a given tool
# Priority: mise > brew/apt > generic
install_hint() {
  local tool="$1"
  local mise_cmd="${2:-}"
  local brew_cmd="${3:-}"
  local apt_cmd="${4:-}"
  local generic="${5:-}"

  if [ "$HAS_MISE" = true ] && [ -n "$mise_cmd" ]; then
    echo "$mise_cmd"
  elif [ "$OS" = "Darwin" ] && [ "$HAS_BREW" = true ] && [ -n "$brew_cmd" ]; then
    echo "$brew_cmd"
  elif [ "$OS" = "Linux" ] && [ "$HAS_APT" = true ] && [ -n "$apt_cmd" ]; then
    echo "sudo $apt_cmd"
  elif [ -n "$generic" ]; then
    echo "$generic"
  else
    echo "Install $tool using your preferred method"
  fi
}

# ── Prerequisite Checks ──

step "Checking prerequisites ($OS)"

MISSING=()

# Node 24+
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -lt 24 ]; then
    hint=$(install_hint "Node 24" "mise use node@24" "brew install node@24" "" "https://nodejs.org")
    fail "Node.js 24+ required (found $(node -v)). Upgrade: $hint"
  fi
  info "Node.js $(node -v)"
else
  hint=$(install_hint "Node.js" "mise use node@24" "brew install node@24" "apt install nodejs" "https://nodejs.org")
  fail "Node.js 24+ not found. Install: $hint"
fi

# Docker (optional but preferred)
if command -v docker &>/dev/null; then
  # Use ERE (-E) instead of PCRE (-P): BSD grep on macOS rejects -P.
  info "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
else
  hint=$(install_hint "Docker" "" "brew install --cask docker" "apt install docker.io" "https://docs.docker.com/get-docker/")
  warn "Docker not found (optional). Install: $hint"
  warn "Without Docker, the orchestrator runs directly via Node."
fi

# tmux
if command -v tmux &>/dev/null; then
  info "tmux $(tmux -V)"
else
  hint=$(install_hint "tmux" "" "brew install tmux" "apt install tmux" "")
  fail "tmux not found. Install: $hint"
fi

# At least one AI CLI
AI_FOUND=false
for cli in claude codex opencode; do
  if command -v "$cli" &>/dev/null; then
    info "$cli CLI found"
    AI_FOUND=true
  fi
done
if [ "$AI_FOUND" = false ]; then
  warn "No AI CLI found (claude, codex, or opencode). Agents won't be able to spawn."
  if [ "$OS" = "Darwin" ]; then
    warn "  Install Claude: brew install claude"
  else
    warn "  Install Claude: npm install -g @anthropic-ai/claude-code"
  fi
fi

# mise (recommend if missing)
if [ "$HAS_MISE" = true ]; then
  info "mise $(mise --version 2>/dev/null | head -1)"
else
  echo -e "${DIM}  tip: install mise for automatic Node version management: https://mise.jdx.dev${RESET}"
fi

# ── Write Build Version ──

# Extract version from package.json so both proxy and orchestrator read the same value.
# .build-version is gitignored — written at launch, not checked in.
PKG_VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")
echo "$PKG_VERSION" > .build-version
info "Version: $PKG_VERSION"

# ── Prepare Config Directory ──

# Pre-create config dir so Docker bind-mount inherits host user ownership.
# Without this, Docker creates it as root and the secret file becomes unreadable.
mkdir -p "${HOME}/.config/agentic-collab"

# ── Activate collab CLI ──

COLLAB_BIN="$SCRIPT_DIR/bin"
if [ -f "$COLLAB_BIN/collab" ]; then
  SHELL_NAME="$(basename "$SHELL")"
  MARKER="# agentic-collab CLI"
  FISH_MARKER="# agentic-collab CLI"

  case "$SHELL_NAME" in
    zsh)
      RC_FILE="$HOME/.zshrc"
      ;;
    bash)
      # macOS login shells source .bash_profile, not .bashrc.
      # Most Linux .bash_profile / .profile sources .bashrc, but not always.
      # Write to .bashrc and ensure .bash_profile sources it on macOS.
      RC_FILE="$HOME/.bashrc"
      if [ "$OS" = "Darwin" ] && [ -f "$HOME/.bash_profile" ]; then
        if ! grep -qF '.bashrc' "$HOME/.bash_profile" 2>/dev/null; then
          echo "" >> "$HOME/.bash_profile"
          echo '# Source .bashrc for login shells' >> "$HOME/.bash_profile"
          echo '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"' >> "$HOME/.bash_profile"
          info "Added .bashrc sourcing to .bash_profile (macOS login shell fix)"
        fi
      fi
      ;;
    fish)
      FISH_CONF="$HOME/.config/fish/config.fish"
      mkdir -p "$(dirname "$FISH_CONF")"
      if ! grep -qF "$FISH_MARKER" "$FISH_CONF" 2>/dev/null; then
        echo "" >> "$FISH_CONF"
        echo "$FISH_MARKER" >> "$FISH_CONF"
        echo "fish_add_path $COLLAB_BIN" >> "$FISH_CONF"
        info "Added collab CLI to PATH in $FISH_CONF"
      else
        info "collab CLI already in $FISH_CONF"
      fi
      RC_FILE=""  # already handled
      ;;
    *)
      RC_FILE=""
      warn "Unknown shell '$SHELL_NAME' — add $COLLAB_BIN to your PATH manually"
      ;;
  esac

  if [ -n "${RC_FILE:-}" ]; then
    if ! grep -qF "$MARKER" "$RC_FILE" 2>/dev/null; then
      echo "" >> "$RC_FILE"
      echo "$MARKER" >> "$RC_FILE"
      echo "export PATH=\"$COLLAB_BIN:\$PATH\"" >> "$RC_FILE"
      info "Added collab CLI to PATH in $RC_FILE"
      info "  Run 'source $RC_FILE' or start a new shell to activate"
    else
      info "collab CLI already in $RC_FILE"
    fi
  fi

  # Also activate for this session
  export PATH="$COLLAB_BIN:$PATH"
fi

# ── Start Orchestrator ──

step "Starting orchestrator"

if command -v docker &>/dev/null; then
  if docker compose version &>/dev/null 2>&1; then
    # Export UID/GID so docker-compose.yml user: "${UID}:${GID}" runs as the host user.
    # This ensures secret files created inside the container are owned by the host user.
    export UID GID="$(id -g)"
    # Pass host-side personas directory so the API can show real file paths.
    # Resolves symlinks so Docker mounts the real directory (not the symlink).
    export PERSONAS_HOST_DIR
    PERSONAS_HOST_DIR="${PERSONAS_HOST_DIR:-$(realpath ./persistent-agents 2>/dev/null || echo '')}"

    # ── Smart Rebuild Decision ──
    # If source has changed since the last build (detected by comparing the
    # current git HEAD SHA against the SHA stamped into .build-image-sha at
    # the previous build), rebuild automatically. Otherwise reuse the cached
    # image. Operator can force either direction with --build / --no-build.
    ORCH_IMAGE=$(docker compose config --images 2>/dev/null | head -1)
    CONTAINER_RUNNING=false
    docker compose ps --status running 2>/dev/null | grep -q orchestrator && CONTAINER_RUNNING=true

    CURRENT_SHA=""
    if command -v git &>/dev/null && git -C "$SCRIPT_DIR" rev-parse --git-dir &>/dev/null; then
      CURRENT_SHA=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo "")
    fi
    LAST_BUILD_SHA=""
    if [ -f "$SCRIPT_DIR/.build-image-sha" ]; then
      LAST_BUILD_SHA=$(cat "$SCRIPT_DIR/.build-image-sha" 2>/dev/null || echo "")
    fi

    SHOULD_BUILD=false
    BUILD_REASON=""
    case "$FORCE_BUILD" in
      yes)
        SHOULD_BUILD=true
        BUILD_REASON="--build flag"
        ;;
      no)
        SHOULD_BUILD=false
        BUILD_REASON="--no-build flag (overriding source-change detection)"
        ;;
      auto)
        if [ "$CONTAINER_RUNNING" = false ]; then
          SHOULD_BUILD=true
          BUILD_REASON="container not running"
        elif [ -z "$CURRENT_SHA" ]; then
          SHOULD_BUILD=true
          BUILD_REASON="cannot determine current git HEAD — rebuilding to be safe"
        elif [ -z "$LAST_BUILD_SHA" ]; then
          SHOULD_BUILD=true
          BUILD_REASON="no .build-image-sha record from previous build"
        elif [ "$CURRENT_SHA" != "$LAST_BUILD_SHA" ]; then
          SHOULD_BUILD=true
          BUILD_REASON="source changed since last build (HEAD ${CURRENT_SHA:0:7}, last built ${LAST_BUILD_SHA:0:7})"
        else
          SHOULD_BUILD=false
          BUILD_REASON="image up to date with HEAD ${CURRENT_SHA:0:7}"
        fi
        ;;
    esac

    if [ "$DRY_RUN" = true ]; then
      info "DRY RUN — no actions will be taken"
      info "  Container running:  $CONTAINER_RUNNING"
      info "  Current HEAD:       ${CURRENT_SHA:-unknown}"
      info "  Last built SHA:     ${LAST_BUILD_SHA:-unknown}"
      info "  Force build flag:   $FORCE_BUILD"
      info "  Decision:           $([ "$SHOULD_BUILD" = true ] && echo BUILD || echo SKIP) ($BUILD_REASON)"
    fi

    if [ "$SHOULD_BUILD" = true ]; then
      info "Rebuilding orchestrator image: $BUILD_REASON"
      if [ "$DRY_RUN" = false ]; then
        docker compose build
        info "Orchestrator image built"
        if [ -n "$CURRENT_SHA" ]; then
          echo "$CURRENT_SHA" > "$SCRIPT_DIR/.build-image-sha"
        fi
      fi
    else
      info "Reusing cached image: $BUILD_REASON"
    fi

    # ── Check SQLite DB Permissions ──
    # The orchestrator runs as the host user (UID:GID) inside Docker.
    # If the DB was previously created by root (e.g. before the user: directive),
    # the container can't write to it → SQLITE_READONLY errors.
    #
    # Derive the volume name from the current compose project rather than
    # hard-coding it: docker compose name-spaces volumes with the project
    # name, which defaults to the directory basename. On this checkout
    # (`~/dev/conductor`), the volume is `conductor_orchestrator-data`;
    # on a fresh clone of `agentic-collab` it would be
    # `agentic-collab_orchestrator-data`. The previous hard-coded value was
    # silently wrong on the conductor checkout, leaving the ownership-fix
    # block as dead code.
    COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$SCRIPT_DIR")}"
    SHORT_VOLUME_NAME=$(docker compose config --volumes 2>/dev/null | head -1)
    if [ -n "$SHORT_VOLUME_NAME" ]; then
      VOLUME_NAME="${COMPOSE_PROJECT}_${SHORT_VOLUME_NAME}"
    else
      VOLUME_NAME="${COMPOSE_PROJECT}_orchestrator-data"
    fi
    DB_MOUNT="/data/.agentic-collab"

    if docker volume inspect "$VOLUME_NAME" &>/dev/null; then
      CURRENT_UID=$(id -u)
      CURRENT_GID=$(id -g)

      # Check ownership of all files in the volume, not just the directory.
      # The directory may have correct ownership while files inside (orchestrator.db,
      # .db-wal, .db-shm) are still owned by root from a previous run.
      BAD_FILES=$(docker run --rm -v "${VOLUME_NAME}:${DB_MOUNT}" "${ORCH_IMAGE}" \
        find "${DB_MOUNT}" -not -uid "${CURRENT_UID}" -o -not -gid "${CURRENT_GID}" \
        2>/dev/null | head -5 || echo "")

      if [ -n "$BAD_FILES" ]; then
        warn "SQLite data volume has files with wrong ownership (expected ${CURRENT_UID}:${CURRENT_GID}):"
        echo "$BAD_FILES" | while read -r f; do echo -e "  ${DIM}$f${RESET}"; done
        warn "This will cause 'access denied' or 'SQLITE_READONLY' errors."
        echo ""
        echo -e "  ${BOLD}Fix with:${RESET}"
        echo -e "    docker run --rm -v ${VOLUME_NAME}:${DB_MOUNT} ${ORCH_IMAGE} chown -R ${CURRENT_UID}:${CURRENT_GID} ${DB_MOUNT}"
        echo ""
        read -rp "  Run this fix now? [Y/n] " REPLY
        REPLY="${REPLY:-Y}"
        if [[ "$REPLY" =~ ^[Yy]$ ]]; then
          docker run --rm --user root -v "${VOLUME_NAME}:${DB_MOUNT}" "${ORCH_IMAGE}" \
            chown -R "${CURRENT_UID}:${CURRENT_GID}" "${DB_MOUNT}"
          info "Fixed volume ownership to ${CURRENT_UID}:${CURRENT_GID}"
        else
          warn "Skipped. The orchestrator may fail to start."
        fi
      fi
    fi

    # Start (or restart) the container. If we rebuilt the image, restart the
    # container so it picks up the new image. If we did not rebuild and the
    # container is already running, leave it as-is.
    if [ "$DRY_RUN" = true ]; then
      info "DRY RUN — would $([ "$SHOULD_BUILD" = true ] && [ "$CONTAINER_RUNNING" = true ] && echo "restart" || echo "$([ "$CONTAINER_RUNNING" = true ] && echo "leave running" || echo "start")") container"
    elif [ "$SHOULD_BUILD" = true ] && [ "$CONTAINER_RUNNING" = true ]; then
      info "Restarting orchestrator to pick up new image"
      docker compose up -d --force-recreate
    elif [ "$CONTAINER_RUNNING" = true ]; then
      info "Orchestrator already running"
    else
      docker compose up -d
      info "Orchestrator starting via Docker Compose"
    fi
  else
    hint=$(install_hint "Docker Compose" "" "brew install docker-compose" "apt install docker-compose-v2" "")
    fail "Docker Compose not available. Install: $hint"
  fi
else
  if [ "$DRY_RUN" = true ]; then
    info "DRY RUN — would run orchestrator directly (no Docker)"
  else
    warn "Running orchestrator directly (no Docker)."
    node src/orchestrator/main.ts &
    ORCH_PID=$!
    info "Orchestrator PID: $ORCH_PID"
  fi
fi

if [ "$DRY_RUN" = true ]; then
  info "DRY RUN complete — exiting before health check / proxy start"
  exit 0
fi

# ── Resolve Orchestrator Host Port ──
#
# Host port priority:
#   1. --port <N> CLI flag (highest — explicit per-invocation override).
#   2. ORCHESTRATOR_HOST_PORT env var (operator override for multi-instance dev).
#   3. `docker compose port orchestrator 3000` (canonical: reflects whatever
#      docker-compose.yml currently maps; auto-syncs if compose changes).
#   4. Hardcoded fallback `3001` (current compose default — kept as a last
#      resort if docker tooling is unavailable, with a warning).
#
# The container always listens on port 3000 internally; this only affects what
# the host script and curl health-check use.
HOST_PORT=""
PORT_SOURCE=""
if [ -n "$PORT_FLAG" ]; then
  HOST_PORT="$PORT_FLAG"
  PORT_SOURCE="--port flag"
elif [ -n "${ORCHESTRATOR_HOST_PORT:-}" ]; then
  HOST_PORT="$ORCHESTRATOR_HOST_PORT"
  PORT_SOURCE="ORCHESTRATOR_HOST_PORT env var"
elif command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
  # `docker compose port` returns "0.0.0.0:3001" for the host-side mapping of
  # the container's port 3000. Extract just the port.
  MAPPED=$(docker compose port orchestrator 3000 2>/dev/null || echo "")
  if [ -n "$MAPPED" ]; then
    HOST_PORT="${MAPPED##*:}"
    PORT_SOURCE="docker compose port mapping"
  fi
fi
if [ -z "$HOST_PORT" ]; then
  HOST_PORT=3001
  PORT_SOURCE="fallback default"
  warn "Could not resolve host port from docker compose; falling back to 3001."
  warn "Override with ORCHESTRATOR_HOST_PORT=<port> if your docker-compose maps differently."
fi
info "Orchestrator host port: $HOST_PORT (source: $PORT_SOURCE)"

# ── Wait for Orchestrator Health ──

step "Waiting for orchestrator"

MAX_WAIT=30
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  # Container listens on 3000 internally; we curl the host-published port.
  if curl -sf "http://localhost:${HOST_PORT}/api/orchestrator/status" &>/dev/null; then
    info "Orchestrator healthy"
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
  if [ $((WAITED % 5)) -eq 0 ]; then
    echo -e "${DIM}  ... waiting ($WAITED/${MAX_WAIT}s)${RESET}"
  fi
done

if [ $WAITED -ge $MAX_WAIT ]; then
  fail "Orchestrator did not become healthy within ${MAX_WAIT}s (tried http://localhost:${HOST_PORT}/api/orchestrator/status)"
fi

# ── Start Proxy ──

step "Starting proxy"

if bash "$SCRIPT_DIR/scripts/start-proxy-tmux.sh" --wait-healthy; then
  info "Proxy tmux session: agentic-proxy"
  info "Attach with: tmux attach -t agentic-proxy"
else
  fail "Proxy failed to start in tmux session agentic-proxy"
fi

info "Dashboard: http://localhost:${HOST_PORT}/dashboard"
echo ""
info "Bootstrap complete"
